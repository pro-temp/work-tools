import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import {
  acquireWorktreeLease,
  isMainModule,
  listSlots,
  normFsPath,
  normRealFsPath,
  releaseWorktreeLease,
  writeFileAtomic,
} from './slots.mjs';

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

export function getWorktreeRoot(overrideRoot = '') {
  if (overrideRoot) return resolve(overrideRoot);
  if (process.env.CODEX_LOOP_WORKTREE_ROOT) return resolve(process.env.CODEX_LOOP_WORKTREE_ROOT);
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, 'codex-loop', 'worktrees');
}

function safeSlug(text, fallback = 'item') {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || fallback;
}

function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: opts.encoding ?? 'utf8',
    windowsHide: true,
    maxBuffer: MAX_GIT_BUFFER,
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function tryGit(args, cwd, opts = {}) {
  try {
    return { ok: true, stdout: git(args, cwd, opts), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      status: err.status ?? 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : err.message,
    };
  }
}

function parsePorcelainZ(rawBuf) {
  const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf || '');
  const tokens = text.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const filePath = rec.slice(3);
    let origPath = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      origPath = tokens[++i] || null;
    }
    entries.push({ xy, path: filePath, origPath, untracked: xy === '??' });
  }
  return entries;
}

function getRepoStatusEntries(dir) {
  const buf = git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignore-submodules=none'], dir, { encoding: 'buffer' });
  return parsePorcelainZ(buf);
}

function normRelPath(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function isExcludedByLinks(relPath, linkedDirs) {
  if (!linkedDirs || linkedDirs.length === 0) return false;
  const norm = normRelPath(relPath);
  for (const ld of linkedDirs) {
    const l = normRelPath(ld);
    if (norm === l || norm.startsWith(`${l}/`)) return true;
  }
  return false;
}

// Per-worktree metadata files eliminate parallel prepare/cleanup manifest clobbering and truncation.
function getMetaDir(root) {
  return join(root, 'meta');
}

function getMetaPath(root, worktreePath) {
  const key = createHash('sha1').update(normRealFsPath(worktreePath)).digest('hex');
  return join(getMetaDir(root), `${key}.json`);
}

function writeWorktreeMeta(root, entry) {
  writeFileAtomic(getMetaPath(root, entry.worktree_path), JSON.stringify(entry, null, 2));
}

function readWorktreeMeta(root, worktreePath) {
  const p = getMetaPath(root, worktreePath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function removeWorktreeMeta(root, worktreePath) {
  const p = getMetaPath(root, worktreePath);
  try { rmSync(p, { force: true }); } catch {}
}

function listAllWorktreeMeta(root) {
  const dir = getMetaDir(root);
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed && parsed.worktree_path) entries.push(parsed);
    } catch {}
  }
  entries.sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0));
  return entries;
}

function resolveGitRepo(repoDir) {
  if (!repoDir) {
    return { ok: false, error_kind: 'missing_repo_dir', message: 'RepoDir is required.' };
  }
  const res = tryGit(['rev-parse', '--show-toplevel'], repoDir);
  if (!res.ok) {
    return { ok: false, error_kind: 'not_git_repo', message: `Not a Git repository: ${repoDir}` };
  }
  const repoRoot = resolve(res.stdout.trim());
  const commonRes = tryGit(['rev-parse', '--git-common-dir'], repoRoot);
  if (!commonRes.ok) {
    return { ok: false, error_kind: 'not_git_repo', message: `Unable to resolve git common dir: ${repoRoot}` };
  }
  const commonDir = resolve(repoRoot, commonRes.stdout.trim());
  const headRes = tryGit(['rev-parse', 'HEAD'], repoRoot);
  if (!headRes.ok) {
    return { ok: false, error_kind: 'unborn_head', message: `Repository has no commits (unborn HEAD): ${repoRoot}` };
  }
  const branchRes = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  return {
    ok: true,
    repoRoot,
    commonDir,
    head: headRes.stdout.trim(),
    branch: branchRes.ok ? branchRes.stdout.trim() : 'HEAD',
  };
}

function verifyWorktreeOwnership(absWt, repo, meta, { requireManaged = false } = {}) {
  if (requireManaged) {
    if (!meta) {
      return {
        ok: false,
        error_kind: 'unmanaged_worktree',
        message: `Refusing operation: "${absWt}" is not a managed codex-loop worktree.`,
      };
    }
    if (!meta.branch || !String(meta.branch).startsWith('codex-loop/')) {
      return {
        ok: false,
        error_kind: 'unmanaged_worktree',
        message: `Refusing operation: metadata branch "${meta.branch}" is not a managed codex-loop branch.`,
      };
    }
  }

  if (meta && normRealFsPath(meta.repo_root) !== normRealFsPath(repo.repoRoot)) {
    return {
      ok: false,
      error_kind: 'worktree_repo_mismatch',
      expected_repo: meta.repo_root,
      provided_repo: repo.repoRoot,
      message: `Worktree belongs to repository "${meta.repo_root}", not "${repo.repoRoot}".`,
    };
  }

  if (normRealFsPath(absWt) === normRealFsPath(repo.repoRoot)) {
    return {
      ok: false,
      error_kind: 'worktree_repo_mismatch',
      message: `Refusing operation: target path "${absWt}" is the main repository itself, not a worktree.`,
    };
  }

  if (existsSync(absWt)) {
    const wtTopRes = tryGit(['rev-parse', '--show-toplevel'], absWt);
    const wtCommonRes = tryGit(['rev-parse', '--git-common-dir'], absWt);
    if (!wtTopRes.ok || !wtCommonRes.ok) {
      return {
        ok: false,
        error_kind: 'invalid_worktree',
        message: `Target path is not a valid Git worktree: ${absWt}`,
      };
    }
    const wtTop = resolve(wtTopRes.stdout.trim());
    const wtCommon = resolve(absWt, wtCommonRes.stdout.trim());
    if (normRealFsPath(wtTop) !== normRealFsPath(absWt)) {
      return {
        ok: false,
        error_kind: 'worktree_repo_mismatch',
        message: `Target path "${absWt}" is not the worktree root (root is "${wtTop}").`,
      };
    }
    if (normRealFsPath(wtCommon) !== normRealFsPath(repo.commonDir)) {
      return {
        ok: false,
        error_kind: 'worktree_repo_mismatch',
        message: `Worktree "${absWt}" does not share Git common dir with repository "${repo.repoRoot}".`,
      };
    }
  }

  return { ok: true };
}

export async function prepareWorktree({
  repoDir,
  batchId,
  subtaskId,
  baseRef = 'HEAD',
  basePolicy = 'clean',
  worktreeRoot = '',
  linkDirs = [],
}) {
  const normPolicy = String(basePolicy || 'clean').toLowerCase();
  if (normPolicy !== 'clean' && normPolicy !== 'head') {
    return { ok: false, error_kind: 'invalid_arguments', message: `Unsupported basePolicy "${basePolicy}"; expected clean or head.` };
  }

  const repo = resolveGitRepo(repoDir);
  if (!repo.ok) return repo;

  // Always resolve baseRef to a commit object (peeling annotated tags).
  const baseRes = tryGit(['rev-parse', '--verify', `${baseRef}^{commit}`], repo.repoRoot);
  if (!baseRes.ok) {
    return { ok: false, error_kind: 'invalid_base_ref', message: `Cannot resolve base ref "${baseRef}" to a commit: ${baseRes.stderr.trim()}` };
  }
  const baseHead = baseRes.stdout.trim();
  const dirtyEntries = getRepoStatusEntries(repo.repoRoot);
  const dirtyFiles = dirtyEntries.map((e) => e.path);

  if (dirtyFiles.length > 0 && normPolicy !== 'head') {
    return {
      ok: false,
      error_kind: 'dirty_repo_for_worktree',
      repo_root: repo.repoRoot,
      base_head: baseHead,
      main_head_at_create: repo.head,
      dirty_files: dirtyFiles,
      message: `Main repository has ${dirtyFiles.length} uncommitted file(s). Confirm subtasks do not depend on them and pass -BasePolicy head, or run serially.`,
    };
  }

  // Validate LinkDirs up front: refuse to link any Git-tracked directory so inspect/integrate never mask tracked edits.
  const validatedLinks = [];
  for (const rel of (Array.isArray(linkDirs) ? linkDirs : [])) {
    const cleanRel = String(rel || '').trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    if (!cleanRel || cleanRel.includes('..')) continue;
    const trackedRes = tryGit(['ls-files', '--', cleanRel], repo.repoRoot);
    if (trackedRes.ok && trackedRes.stdout.trim()) {
      return {
        ok: false,
        error_kind: 'link_dir_tracked',
        link_dir: cleanRel,
        message: `Refusing to link tracked directory "${cleanRel}": LinkDirs is only allowed for untracked directories (e.g. ignored dependencies).`,
      };
    }
    validatedLinks.push(cleanRel);
  }

  const root = getWorktreeRoot(worktreeRoot);
  const repoHash = createHash('sha1').update(normRealFsPath(repo.repoRoot)).digest('hex').slice(0, 8);
  const repoSlug = `${safeSlug(basename(repo.repoRoot), 'repo')}-${repoHash}`;
  const bSlug = safeSlug(batchId || `b-${Date.now().toString(36)}`, 'batch');
  const sSlug = safeSlug(subtaskId || 'sub', 'sub');
  const wtPath = join(root, repoSlug, `${bSlug}-${sSlug}`);
  const branch = `codex-loop/${bSlug}/${sSlug}`;

  if (existsSync(wtPath)) {
    return { ok: false, error_kind: 'worktree_exists', worktree_path: wtPath, message: `Worktree path already exists: ${wtPath}` };
  }
  const branchCheck = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo.repoRoot);
  if (branchCheck.ok) {
    return { ok: false, error_kind: 'branch_exists', branch, message: `Worktree branch already exists: ${branch}` };
  }

  mkdirSync(dirname(wtPath), { recursive: true });
  const addRes = tryGit(['worktree', 'add', '-b', branch, wtPath, baseHead], repo.repoRoot);
  if (!addRes.ok) {
    return { ok: false, error_kind: 'worktree_create_failed', message: addRes.stderr.trim() || addRes.stdout.trim() };
  }

  const linked = [];
  let wtGitDir = null;
  try {
    wtGitDir = resolve(wtPath, git(['rev-parse', '--git-dir'], wtPath).trim());
    for (const cleanRel of validatedLinks) {
      const src = join(repo.repoRoot, cleanRel);
      const dst = join(wtPath, cleanRel);
      if (existsSync(src) && !existsSync(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
        linked.push(cleanRel.replace(/\\/g, '/'));
      }
    }

    const entry = {
      repo_root: repo.repoRoot,
      worktree_path: wtPath,
      git_dir: wtGitDir,
      branch,
      batch_id: batchId || bSlug,
      subtask_id: subtaskId || sSlug,
      base_ref: baseRef,
      base_head: baseHead,
      main_head_at_create: repo.head,
      base_policy: normPolicy,
      main_dirty_files_at_create: dirtyFiles,
      linked_dirs: linked,
      link_dirs_shared_writable: linked.length > 0,
      created_at: new Date().toISOString(),
    };
    writeWorktreeMeta(root, entry);
    return { ok: true, ...entry };
  } catch (err) {
    // Roll back ONLY the worktree and branch created by this failed prepare call so retries never get stuck.
    for (const rel of linked) {
      const linkPath = join(wtPath, rel);
      try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          if (process.platform === 'win32') rmdirSync(linkPath);
          else unlinkSync(linkPath);
        }
      } catch {}
    }
    tryGit(['worktree', 'remove', '--force', wtPath], repo.repoRoot);
    tryGit(['worktree', 'prune'], repo.repoRoot);
    tryGit(['branch', '-D', branch], repo.repoRoot);
    removeWorktreeMeta(root, wtPath);
    return {
      ok: false,
      error_kind: 'worktree_prepare_failed',
      worktree_path: wtPath,
      message: `Worktree preparation failed and was rolled back: ${err?.message || String(err)}`,
    };
  }
}

function resolveWorktreeBase(worktreePath, baseHeadArg, root) {
  const meta = readWorktreeMeta(root, worktreePath);
  const baseHead = baseHeadArg || meta?.base_head || '';
  if (!baseHead) {
    return { ok: false, error_kind: 'missing_base_head', message: `Base HEAD is unknown for worktree ${worktreePath}; pass -BaseHead explicitly.` };
  }
  return { ok: true, baseHead, manifest: meta };
}

function collectWorktreeChanges(worktreePath, baseHead, linkedDirs) {
  const statusEntries = getRepoStatusEntries(worktreePath).filter((e) => !isExcludedByLinks(e.path, linkedDirs));
  const diffNamesRaw = git(['--no-optional-locks', 'diff', '--name-status', '-z', '--ignore-submodules=none', baseHead], worktreePath, { encoding: 'buffer' }).toString('utf8');
  const tokens = diffNamesRaw.split('\0').filter((t) => t.length > 0);
  const trackedChanges = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = tokens[++i];
      const to = tokens[++i];
      if (!isExcludedByLinks(to, linkedDirs)) trackedChanges.push({ status: code, path: to, from });
    } else {
      const p = tokens[++i];
      if (p && !isExcludedByLinks(p, linkedDirs)) trackedChanges.push({ status: code, path: p });
    }
  }

  const untrackedFiles = statusEntries.filter((e) => e.untracked).map((e) => e.path);
  const pathSet = new Set();
  for (const tc of trackedChanges) {
    pathSet.add(tc.path);
    if (tc.from) pathSet.add(tc.from);
  }
  for (const uf of untrackedFiles) pathSet.add(uf);

  const statOut = tryGit(['--no-optional-locks', 'diff', '--stat', '--ignore-submodules=none', baseHead], worktreePath).stdout.trim();
  const wtHead = git(['rev-parse', 'HEAD'], worktreePath).trim();
  return {
    wtHead,
    trackedChanges,
    untrackedFiles,
    allPaths: [...pathSet].sort(),
    diffStat: statOut,
  };
}

export async function inspectWorktree({ worktreePath, baseHead = '', worktreeRoot = '' }) {
  const absWt = resolve(worktreePath);
  if (!existsSync(absWt)) {
    return { ok: false, error_kind: 'worktree_missing', message: `Worktree does not exist: ${absWt}` };
  }
  const root = getWorktreeRoot(worktreeRoot);
  const baseInfo = resolveWorktreeBase(absWt, baseHead, root);
  if (!baseInfo.ok) return baseInfo;

  const linkedDirs = baseInfo.manifest?.linked_dirs || [];
  const changes = collectWorktreeChanges(absWt, baseInfo.baseHead, linkedDirs);
  return {
    ok: true,
    worktree_path: absWt,
    repo_root: baseInfo.manifest?.repo_root || null,
    branch: baseInfo.manifest?.branch || null,
    base_head: baseInfo.baseHead,
    main_head_at_create: baseInfo.manifest?.main_head_at_create || null,
    head: changes.wtHead,
    has_changes: changes.allPaths.length > 0,
    tracked_changes: changes.trackedChanges,
    untracked_files: changes.untrackedFiles,
    all_paths: changes.allPaths,
    diff_stat: changes.diffStat,
  };
}

function findGitlinkPathsInRawDiff(rawBuf) {
  const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf || '');
  const parts = text.split('\0');
  const gitlinks = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta || !meta.startsWith(':')) continue;
    const fields = meta.slice(1).split(' ');
    const oldMode = fields[0] || '';
    const newMode = fields[1] || '';
    const filePath = parts[++i] || '';
    if (oldMode === '160000' || newMode === '160000') {
      if (filePath) gitlinks.push(filePath);
    }
  }
  return gitlinks;
}

function quoteGitAlternateDir(dirPath) {
  // Git parses double-quoted C-escaped entries in GIT_ALTERNATE_OBJECT_DIRECTORIES so paths with ';' (win32) or ':' (POSIX) are not split.
  const escaped = String(dirPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildUnifiedWorktreePatch(worktreePath, repoCommonDir, baseHead, untrackedFiles) {
  const gitDir = resolve(worktreePath, git(['rev-parse', '--git-dir'], worktreePath).trim());
  const realIndex = join(gitDir, 'index');
  const realObjectsDir = join(repoCommonDir, 'objects');
  const uniq = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const tempIndex = join(tmpdir(), `codex-loop-idx-${uniq}`);
  const tempObjDir = join(tmpdir(), `codex-loop-obj-${uniq}`);
  mkdirSync(tempObjDir, { recursive: true });
  if (existsSync(realIndex)) {
    copyFileSync(realIndex, tempIndex);
  }
  const existingAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const altDirs = existingAlternates
    ? `${quoteGitAlternateDir(realObjectsDir)}${delimiter}${existingAlternates}`
    : quoteGitAlternateDir(realObjectsDir);
  // Isolate both index and new blobs so DryRun and failed checks write zero objects into the shared .git/objects store.
  const env = {
    GIT_INDEX_FILE: tempIndex,
    GIT_OBJECT_DIRECTORY: tempObjDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: altDirs,
  };
  try {
    git(['add', '-u'], worktreePath, { env });
    if (untrackedFiles.length > 0) {
      // Stream NUL-separated literal pathspecs over stdin to avoid Windows argv limits and glob metacharacter issues.
      git(['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], worktreePath, {
        env,
        input: Buffer.from(`${untrackedFiles.join('\0')}\0`, 'utf8'),
      });
    }
    const rawDiff = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--ignore-submodules=none', baseHead], worktreePath, {
      env,
      encoding: 'buffer',
    });
    const submodulePaths = findGitlinkPathsInRawDiff(rawDiff);
    if (submodulePaths.length > 0) {
      return { submodulePaths, patchBuf: null };
    }
    const patchBuf = git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--full-index', '--ignore-submodules=none', baseHead], worktreePath, {
      env,
      encoding: 'buffer',
    });
    return { submodulePaths: [], patchBuf };
  } finally {
    rmSync(tempIndex, { force: true });
    rmSync(tempObjDir, { recursive: true, force: true });
  }
}

export async function integrateWorktree({
  repoDir,
  worktreePath,
  baseHead = '',
  expectedMainHead = '',
  allowHeadDrift = false,
  dryRun = false,
  worktreeRoot = '',
}) {
  const repo = resolveGitRepo(repoDir);
  if (!repo.ok) return repo;

  const absWt = resolve(worktreePath);
  if (!existsSync(absWt)) {
    return { ok: false, error_kind: 'worktree_missing', message: `Worktree does not exist: ${absWt}` };
  }
  const root = getWorktreeRoot(worktreeRoot);
  const baseInfo = resolveWorktreeBase(absWt, baseHead, root);
  if (!baseInfo.ok) return baseInfo;

  const ownership = verifyWorktreeOwnership(absWt, repo, baseInfo.manifest, { requireManaged: false });
  if (!ownership.ok) return ownership;

  const leaseRes = await acquireWorktreeLease({
    worktreePath: absWt,
    op: dryRun ? 'integrate-dry-run' : 'integrate',
  });
  if (!leaseRes.ok) return leaseRes;

  try {
    const targetExpected = expectedMainHead || baseInfo.manifest?.main_head_at_create || baseInfo.baseHead;
    if (targetExpected && repo.head !== targetExpected && !allowHeadDrift) {
      return {
        ok: false,
        error_kind: 'head_drifted',
        expected_head: targetExpected,
        actual_head: repo.head,
        message: `Main repo HEAD drifted (${targetExpected.slice(0, 8)} -> ${repo.head.slice(0, 8)}). Inspect diff or pass -AllowHeadDrift.`,
      };
    }

    const linkedDirs = baseInfo.manifest?.linked_dirs || [];
    const changes = collectWorktreeChanges(absWt, baseInfo.baseHead, linkedDirs);
    if (changes.allPaths.length === 0) {
      return {
        ok: true,
        applied: false,
        dry_run: Boolean(dryRun),
        can_apply: true,
        files: [],
        base_head: baseInfo.baseHead,
        main_head: repo.head,
        message: 'No changes to integrate.',
      };
    }

    const mainDirty = getRepoStatusEntries(repo.repoRoot);
    const mainDirtySet = new Set();
    for (const e of mainDirty) {
      mainDirtySet.add(normRelPath(e.path));
      if (e.origPath) mainDirtySet.add(normRelPath(e.origPath));
    }
    const overlaps = changes.allPaths.filter((p) => mainDirtySet.has(normRelPath(p)));
    if (overlaps.length > 0) {
      return {
        ok: false,
        error_kind: 'dirty_overlap',
        overlaps,
        files: changes.allPaths,
        message: `Refusing to integrate: ${overlaps.length} path(s) overlap with uncommitted changes in main repo.`,
      };
    }

    const { submodulePaths, patchBuf } = buildUnifiedWorktreePatch(absWt, repo.commonDir, baseInfo.baseHead, changes.untrackedFiles);
    if (submodulePaths.length > 0) {
      return {
        ok: false,
        error_kind: 'submodule_not_supported',
        submodules: submodulePaths,
        files: changes.allPaths,
        message: `Refusing to integrate: worktree modifies gitlink/submodule pointer(s) (${submodulePaths.join(', ')}), which git apply cannot safely update.`,
      };
    }
    if (!patchBuf || patchBuf.length === 0) {
      return {
        ok: true,
        applied: false,
        dry_run: Boolean(dryRun),
        can_apply: true,
        files: [],
        base_head: baseInfo.baseHead,
        main_head: repo.head,
      };
    }

    const checkRes = tryGit(['apply', '--check', '--whitespace=nowarn'], repo.repoRoot, { input: patchBuf });
    if (!checkRes.ok) {
      return {
        ok: false,
        error_kind: 'patch_conflict',
        files: changes.allPaths,
        message: `Patch check failed against main repo (main repo left untouched): ${checkRes.stderr.trim()}`,
      };
    }

    if (dryRun) {
      return {
        ok: true,
        applied: false,
        dry_run: true,
        can_apply: true,
        files: changes.allPaths,
        base_head: baseInfo.baseHead,
        main_head: repo.head,
      };
    }

    const applyRes = tryGit(['apply', '--whitespace=nowarn'], repo.repoRoot, { input: patchBuf });
    if (!applyRes.ok) {
      return {
        ok: false,
        error_kind: 'patch_apply_failed',
        files: changes.allPaths,
        message: applyRes.stderr.trim(),
      };
    }

    return {
      ok: true,
      applied: true,
      dry_run: false,
      can_apply: true,
      files: changes.allPaths,
      base_head: baseInfo.baseHead,
      main_head: repo.head,
    };
  } finally {
    try { await releaseWorktreeLease(leaseRes.lease.lease_id); } catch {}
  }
}

export async function cleanupWorktree({
  repoDir,
  worktreePath,
  keepBranch = false,
  force = false,
  worktreeRoot = '',
}) {
  const absWt = resolve(worktreePath);
  const root = getWorktreeRoot(worktreeRoot);
  const meta = readWorktreeMeta(root, absWt);
  const targetRepo = repoDir || meta?.repo_root;
  if (!targetRepo) {
    return {
      ok: false,
      error_kind: meta ? 'missing_repo_dir' : 'unmanaged_worktree',
      message: meta ? 'RepoDir is required to clean up worktree.' : `Refusing cleanup: "${absWt}" is not a managed codex-loop worktree.`,
    };
  }
  const repo = resolveGitRepo(targetRepo);
  if (!repo.ok) return repo;

  const ownership = verifyWorktreeOwnership(absWt, repo, meta, { requireManaged: true });
  if (!ownership.ok) return ownership;

  // Atomically hold an exclusive worktree lease under the shared slots lock so no worker can attach mid-cleanup.
  const leaseRes = await acquireWorktreeLease({ worktreePath: absWt, op: 'cleanup' });
  if (!leaseRes.ok) return leaseRes;

  try {
    // Re-verify live git_dir and checked-out branch under the lease so a manually recreated worktree at the same path is never deleted.
    if (existsSync(absWt)) {
      const liveGitDirRes = tryGit(['rev-parse', '--git-dir'], absWt);
      if (!liveGitDirRes.ok) {
        return { ok: false, error_kind: 'invalid_worktree', message: `Target path is no longer a valid Git worktree: ${absWt}` };
      }
      const liveGitDir = resolve(absWt, liveGitDirRes.stdout.trim());
      if (meta.git_dir && normRealFsPath(liveGitDir) !== normRealFsPath(meta.git_dir)) {
        return {
          ok: false,
          error_kind: 'worktree_branch_mismatch',
          expected_git_dir: meta.git_dir,
          actual_git_dir: liveGitDir,
          message: `Refusing cleanup: "${absWt}" now points to a different Git worktree admin dir than recorded at prepare time.`,
        };
      }
      const liveBranchRes = tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], absWt);
      const liveBranch = liveBranchRes.ok ? liveBranchRes.stdout.trim() : null;
      if (liveBranch !== meta.branch) {
        return {
          ok: false,
          error_kind: 'worktree_branch_mismatch',
          expected_branch: meta.branch,
          actual_branch: liveBranch,
          message: `Refusing cleanup: "${absWt}" is on branch "${liveBranch ?? '(detached)'}" instead of managed branch "${meta.branch}".`,
        };
      }
    }

    // Unlink junctions BEFORE git worktree remove so linked target directories in main repo are never touched.
    for (const rel of (meta.linked_dirs || [])) {
      const linkPath = join(absWt, rel);
      try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          if (process.platform === 'win32') rmdirSync(linkPath);
          else unlinkSync(linkPath);
        }
      } catch {}
    }

    if (existsSync(absWt)) {
      const rmArgs = ['worktree', 'remove', ...(force ? ['--force'] : []), absWt];
      const rmRes = tryGit(rmArgs, repo.repoRoot);
      if (!rmRes.ok) {
        return { ok: false, error_kind: 'worktree_remove_failed', message: rmRes.stderr.trim() || rmRes.stdout.trim() };
      }
    }
    tryGit(['worktree', 'prune'], repo.repoRoot);

    let branchDeleted = false;
    const branch = meta.branch;
    if (!keepBranch && branch && branch.startsWith('codex-loop/')) {
      const delRes = tryGit(['branch', force ? '-D' : '-d', branch], repo.repoRoot);
      if (delRes.ok) {
        branchDeleted = true;
      } else if (!force) {
        const unmerged = tryGit(['rev-list', '--count', `${meta.base_head}..${branch}`], repo.repoRoot);
        if (unmerged.ok && Number(unmerged.stdout.trim()) === 0) {
          branchDeleted = tryGit(['branch', '-D', branch], repo.repoRoot).ok;
        }
      }
    }

    removeWorktreeMeta(root, absWt);
    return { ok: true, removed: true, worktree_path: absWt, branch, branch_deleted: branchDeleted };
  } finally {
    try { await releaseWorktreeLease(leaseRes.lease.lease_id); } catch {}
  }
}

export async function listWorktrees({ repoDir = '', worktreeRoot = '' } = {}) {
  const root = getWorktreeRoot(worktreeRoot);
  const items = listAllWorktreeMeta(root);
  const active = (await listSlots()).slots;
  const targetRepo = repoDir ? normRealFsPath(resolveGitRepo(repoDir).repoRoot || repoDir) : '';

  const filtered = items
    .filter((it) => !targetRepo || normRealFsPath(it.repo_root) === targetRepo)
    .map((it) => {
      const owner = active.find((s) => s.worktree_path && normRealFsPath(s.worktree_path) === normRealFsPath(it.worktree_path)) || null;
      return {
        ...it,
        exists: existsSync(it.worktree_path),
        in_use: Boolean(owner),
        active_attempt_id: owner?.attempt_id ?? null,
      };
    });

  return { ok: true, worktrees: filtered };
}

async function runCli() {
  const cmd = String(process.argv[2] || '').toLowerCase();
  const chunks = [];
  if (!process.stdin.isTTY) {
    for await (const c of process.stdin) chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const payload = raw ? JSON.parse(raw) : {};

  let result;
  if (cmd === 'prepare') result = await prepareWorktree(payload);
  else if (cmd === 'inspect') result = await inspectWorktree(payload);
  else if (cmd === 'integrate') result = await integrateWorktree(payload);
  else if (cmd === 'cleanup') result = await cleanupWorktree(payload);
  else if (cmd === 'list') result = await listWorktrees(payload);
  else throw new Error(`Unknown worktree command: ${cmd}`);

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  runCli().catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error_kind: err?.error_kind || 'worktree_error', message: err.message })}\n`);
    process.exit(1);
  });
}
