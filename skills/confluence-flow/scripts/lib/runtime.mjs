import { openAsBlob } from 'node:fs'
import { access, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { text as readStream } from 'node:stream/consumers'
import { pipeline } from 'node:stream/promises'
import tls from 'node:tls'

let systemCaLoaded = false
function loadSystemCa() {
  if (systemCaLoaded || typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return
  systemCaLoaded = true
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])])
}

function errorText(e) {
  const c = e.cause
  const detail = c && [c.code || c.errors?.[0]?.code, c.message || c.errors?.[0]?.message].filter(Boolean).join(': ')
  return detail ? `${e.message} (${detail})` : e.message
}

export function fail(message) { throw new Error(message) }

export function required(value, label) {
  if (value == null || !String(value).trim()) fail(`请提供 ${label}`)
  return value
}

export function integer(value, label, min = 0) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min)
    fail(`${label} 必须是 ≥ ${min} 的整数`)
  return Number(value)
}

export function choice(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} 可选 ${allowed.join(' | ')}`)
  return value
}

export function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是 JSON 对象`)
  return value
}

function parseJson(source, label) {
  try { return JSON.parse(source) }
  catch { fail(`${label} 的 JSON 格式无效`) }
}

export async function utf8(path) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
}

export async function input(options, field, file = field + '-file') {
  if (options[field] !== undefined && options[file] !== undefined) fail(`--${field} 与 --${file} 只能选一个`)
  return options[file] === undefined ? options[field] : utf8(options[file])
}

export async function fieldsFile(path) {
  return path === undefined ? {} : object(parseJson(await utf8(path), '--fields-file'), '--fields-file')
}

export function csv(value) { return value.split(',').map(s => required(s.trim(), '非空列表项')) }

function optionsFor(spec) {
  return Object.fromEntries(spec.split(' ').filter(Boolean).map(token => {
    const name = token.replace(/[!*]$/, '')
    return [name, { type: token.endsWith('!') ? 'boolean' : 'string', multiple: token.endsWith('*') }]
  }))
}

function cli(spec, argv) {
  const [first, second] = argv
  const command = first === 'auth' || first === 'config' ? first + ' ' + second : first
  const commands = {
    'doctor': ['', '', '检查连接、身份和默认范围'],
    'config show': ['', '', '显示当前配置与凭证状态'],
    'auth set': ['', 'base-url auth-type username email secret-stdin! read-only deployment make-default! ' + spec.scopeFlags, '从 stdin 或环境变量保存凭证'],
    ...spec.commands,
  }
  const entry = Object.hasOwn(commands, command) && commands[command]
  if (first === '--help' || first === '-h' || !first || (entry && argv.includes('--help'))) {
    const lines = [`${spec.name} · node scripts/${spec.name}.mjs <命令> [参数]`, '通用参数  --profile <名称>  --help']
    for (const [key, [args, flags, description]] of Object.entries(entry ? { [command]: entry } : commands)) {
      const syntax = Object.entries(optionsFor(flags)).map(([flag, o]) =>
        '--' + flag + (o.type === 'string' ? ' <值>' : '') + (o.multiple ? '…' : '')).join(' ')
      lines.push(`${key} ${args}  ${description}`, '  ' + syntax)
    }
    return { help: lines.join('\n') }
  }
  if (!entry) fail('未知命令。请运行 --help')
  const args = argv.slice(command.includes(' ') ? 2 : 1)
  const { values, positionals } = parseArgs({ args, options: optionsFor('profile ' + entry[1]), allowPositionals: true })
  if (entry[0] === '<KEY...>' ? !positionals.length : positionals.length !== (entry[0] ? 1 : 0))
    fail(`用法：${command} ${entry[0]}`)
  return { command, o: values, args: positionals }
}

const envNames = {
  baseUrl: 'BASE_URL', authType: 'AUTH_TYPE', username: 'USERNAME', email: 'EMAIL',
  token: 'TOKEN', password: 'PASSWORD', deployment: 'DEPLOYMENT', project: 'PROJECT', space: 'SPACE', rootPageId: 'ROOT_PAGE_ID',
}

function layer(record) {
  const result = {}
  for (const key of Object.keys(envNames)) if (record[key] !== undefined) result[key] = record[key]
  // Resolve aliases within each source before applying environment precedence.
  if ('username' in result || 'email' in result) result.username = result.username || result.email
  if ('token' in result || 'password' in result) result.token = result.token || result.password
  delete result.email
  delete result.password
  if ('readOnly' in record) {
    if (typeof record.readOnly !== 'boolean') fail('配置 readOnly 必须为布尔值')
    result.readOnly = record.readOnly
  }
  return result
}

async function settings(path) {
  let source
  try { source = await utf8(path) }
  catch (e) {
    if (e.code === 'ENOENT') return { defaultProfile: 'default', profiles: {} }
    throw e
  }
  const data = object(parseJson(source, '配置文件'), '配置文件')
  object(data.profiles, 'profiles')
  required(data.defaultProfile, 'defaultProfile')
  if (!Object.hasOwn(data.profiles, data.defaultProfile)) fail('defaultProfile 指向不存在的 profile')
  return data
}

function urlFor(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('URL 必须是无内嵌凭证的 HTTP(S) 地址')
  return url
}

function connection(profile, prefix) {
  if (!profile.baseUrl || !profile.token) fail(`缺少连接配置。请运行 auth set --secret-stdin，或设置 ${prefix}_BASE_URL 和 ${prefix}_TOKEN`)
  const url = urlFor(profile.baseUrl)
  if (url.search || url.hash) fail('baseUrl 只能包含站点与上下文路径')
  const authType = choice(profile.authType || (profile.username ? 'basic' : 'bearer'), ['basic', 'bearer'], 'authType')
  if (authType === 'basic') required(profile.username, `${prefix}_USERNAME 或 ${prefix}_EMAIL`)
  const deployment = choice(profile.deployment || (url.hostname.endsWith('.atlassian.net') ? 'cloud' : 'server'), ['cloud', 'server'], 'deployment')
  return { ...profile, baseUrl: url.href.replace(/\/+$/, ''), authType, deployment }
}

async function config(spec, command, o) {
  const prefix = spec.name.toUpperCase()
  const path = resolve(process.env[prefix + '_FLOW_CONFIG'] || join(homedir(), '.config', spec.name + '-flow', 'config.json'))
  const env = layer(Object.fromEntries(Object.entries(envNames).map(([k, v]) => [k, process.env[prefix + '_' + v]])))
  const save = command === 'auth set'
  let lock
  if (save) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const fromSkill = relative(resolve(import.meta.dirname, '../..'), await realpath(dirname(path)))
    if (!isAbsolute(fromSkill) && fromSkill !== '..' && !fromSkill.startsWith('..' + sep))
      fail('用户配置文件必须放在 Skill 目录之外')
    try { lock = await open(path + '.lock', 'wx', 0o600) }
    catch (e) {
      if (e.code === 'EEXIST') fail(`配置正在保存。若上次写入中断，请核对 ${path}.lock`)
      throw e
    }
  }
  try {
    const data = await settings(path)
    const name = required(o.profile ?? process.env[prefix + '_FLOW_PROFILE'] ?? data.defaultProfile, 'profile 名称')
    if (!save && !Object.hasOwn(data.profiles, name) && (Object.keys(data.profiles).length || name !== 'default'))
      fail(`未知 profile「${name}」，请用 auth set --profile 创建`)
    const stored = Object.hasOwn(data.profiles, name) ? layer(object(data.profiles[name], 'profile')) : {}
    const profile = { ...stored, ...env }
    if (save) {
      if (o['secret-stdin'] && process.stdin.isTTY) fail('请从密码管理器或受保护的输入流将密钥通过管道传给 --secret-stdin')
      const secret = o['secret-stdin'] ? (await readStream(process.stdin)).replace(/\r?\n$/, '') : env.token
      required(secret, `--secret-stdin 或 ${prefix}_TOKEN / ${prefix}_PASSWORD`)
      Object.assign(profile, layer({ ...o, baseUrl: o['base-url'], authType: o['auth-type'], rootPageId: o['root-page-id'] }), { token: secret })
      if (o['read-only'] !== undefined) profile.readOnly = choice(o['read-only'], ['true', 'false'], '--read-only') === 'true'
      connection(profile, prefix)
      if (o['make-default'] || !Object.keys(data.profiles).length) data.defaultProfile = name
      Object.defineProperty(data.profiles, name, { value: profile, enumerable: true, configurable: true, writable: true })
      await lock.writeFile(JSON.stringify(data, null, 2) + '\n')
      await lock.close()
      await rename(path + '.lock', path)
      lock = undefined
    }
    if (save || command === 'config show') {
      const { token, ...visible } = profile
      if (visible.baseUrl) {
        const url = urlFor(visible.baseUrl)
        visible.baseUrl = url.origin + url.pathname
      }
      return { output: { path, profile: name, defaultProfile: data.defaultProfile, profiles: Object.keys(data.profiles), ...visible, credentialConfigured: Boolean(token) } }
    }
    return { profile: connection(profile, prefix) }
  } finally {
    if (lock) { await lock.close(); await unlink(path + '.lock') }
  }
}

export class HttpError extends Error {
  constructor(status, detail) { super(`HTTP ${status} ${detail}`); this.status = status }
}

export function unavailable(error) { return error instanceof HttpError && [404, 405, 410].includes(error.status) }

function atlassianErrorMessages(data) {
  if (data === null || typeof data !== 'object') return []
  const messages = [data.message]
  for (const group of [data.errorMessages, data.errors, data.data?.errors]) {
    if (!group || typeof group !== 'object') continue
    for (const [field, item] of Object.entries(group)) {
      const message = typeof item === 'string' ? item : item?.message || item?.detail || item?.title
      const reason = typeof message === 'string' ? message : message?.translation || message?.key
      if (typeof reason === 'string') messages.push(Array.isArray(group) ? reason : field + ': ' + reason)
    }
  }
  return messages
}

async function httpErrorDetail(response, authorization, secret) {
  if (!response.body) return ''
  const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
  const json = type === 'application/json' || type.endsWith('+json')
  if (response.status < 400 || (type && type !== 'text/plain' && !json)) {
    await response.body.cancel()
    return ''
  }

  const prefix = Buffer.alloc(8192)
  let size = 0
  try {
    for await (const chunk of response.body) {
      const part = chunk.subarray(0, prefix.length - size)
      prefix.set(part, size)
      size += part.length
      if (size === prefix.length) break // Exiting the iterator cancels the remaining stream.
    }
  } catch { return '' } // The HTTP status still applies if the diagnostic body was interrupted.

  const text = prefix.toString('utf8', 0, size).trim()
  if (!text || text.startsWith('<')) return ''
  let messages = [text]
  if (json || text.startsWith('{')) {
    let data
    try { data = JSON.parse(text) }
    catch { return '' } // A truncated or malformed JSON envelope can contain unrelated fields.
    messages = atlassianErrorMessages(data)
  }
  const unsafe = /<(?:!doctype\s+html|html)\b|^<(?:head|body)\b|\b(?:headers|authorization|cookie|set-cookie)["']?\s*[:=]|^(?:accept|content-type|user-agent|host|x-[\w-]+)\s*:/i
  const lines = messages.filter(m => typeof m === 'string').map(m => m.trim().split(/[\r\n]/, 1)[0])
    .filter(line => line && !unsafe.test(line))
  const detail = [...new Set(lines)].join('；')
    .replaceAll(authorization.slice(authorization.indexOf(' ') + 1), '[已隐藏]').replaceAll(secret, '[已隐藏]')
  const chars = Array.from(detail)
  return chars.length > 512 ? chars.slice(0, 511).join('') + '…' : detail
}

function client(profile, name) {
  const authorization = profile.authType === 'basic'
    ? 'Basic ' + Buffer.from(profile.username + ':' + profile.token).toString('base64') : 'Bearer ' + profile.token
  const origin = new URL(profile.baseUrl).origin
  if (origin.startsWith('https://')) loadSystemCa()
  async function request(path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(profile.baseUrl + '/' + path)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value)
    const headers = { Authorization: authorization, Accept: 'application/json' }
    const multipart = body instanceof FormData
    if (multipart) headers['X-Atlassian-Token'] = name === 'jira' ? 'no-check' : 'nocheck'
    else if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, { method, headers, body: multipart ? body : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(multipart ? 120000 : 30000) })
    if (!response.ok) {
      const hints = { 400: '请求或字段无效', 401: '请检查凭证', 403: '账号没有所需权限', 404: '目标或接口不存在',
        409: '版本冲突，请重新读取', 410: '接口已移除', 413: '附件超过服务器限制', 429: '请求过于频繁' }
      const hint = hints[response.status] || (response.status < 400 ? '重定向，请检查 baseUrl' : response.statusText)
      const detail = await httpErrorDetail(response, authorization, profile.token)
      throw new HttpError(response.status, detail ? hint + '：' + detail : hint)
    }
    const raw = await response.text()
    return raw === '' ? undefined : parseJson(raw, '服务器响应（请检查 API 地址与登录状态）')
  }
  async function download(source, path) {
    let url = urlFor(new URL(source, profile.baseUrl + '/').href)
    let authenticated = url.origin === origin
    for (let hop = 0; hop <= 8; hop++) {
      if (url.protocol === 'https:') loadSystemCa()
      const response = await fetch(url, { headers: authenticated ? { Authorization: authorization } : {},
        redirect: 'manual', signal: AbortSignal.timeout(120000) })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        url = urlFor(new URL(required(response.headers.get('location'), '重定向 Location'), url).href)
        authenticated = authenticated && url.origin === origin
        continue
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new HttpError(response.status, '附件下载失败')
      }
      let handle
      try {
        handle = await open(path, 'wx')
        await pipeline(response.body, handle.createWriteStream())
      } catch (e) {
        if (handle) { await handle.close(); await unlink(path) }
        else await response.body.cancel()
        throw e
      }
      return
    }
    fail('附件重定向次数过多')
  }
  return { profile, request, get: (path, query) => request(path, { query }), download }
}

export async function localFiles(paths, limit = Infinity) {
  return Promise.all(paths.map(async path => {
    await access(path, constants.R_OK)
    const info = await stat(path)
    if (!info.isFile() || info.size > limit) fail(`文件不可上传或超过 ${limit} 字节：${path}`)
    return { path, name: basename(path), size: info.size }
  }))
}

export async function multipart(file) {
  const ext = file.name.split('.').at(-1).toLowerCase()
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' }[ext]
  const form = new FormData()
  form.append('file', await openAsBlob(file.path, { type: type || 'application/octet-stream' }), file.name)
  return form
}

export async function downloadFiles(api, items, o) {
  const dir = resolve(required(o.output, '--output'))
  if (o.id && o.name) fail('--id 与 --name 只能选一个')
  const selected = items.filter(item => (!o.id || String(item.id) === o.id) && (!o.name || item.name === o.name))
  if ((o.id || o.name) && selected.length !== 1) fail('附件未唯一匹配，请查看 attachments 并指定 --id')
  await mkdir(dir, { recursive: true })
  const files = []
  for (const item of selected) {
    if (!item.name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(item.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(item.name))
      fail('附件名无法安全用作本地文件名')
    const path = join(dir, item.name)
    await api.download(required(item.url, '附件下载地址'), path)
    files.push({ id: item.id, path })
  }
  return { files }
}

export async function batch(items, run) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      try { results[index] = await run(items[index]) }
      catch (e) { results[index] = { target: items[index], error: errorText(e) } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  return results
}

export function partial(value) { process.exitCode = 2; return value }

export async function runCli(spec, execute) {
  try {
    const { help, command, o, args } = cli(spec, process.argv.slice(2))
    if (help) { console.log(help); return }
    const settings = await config(spec, command, o)
    if (settings.output) { console.log(JSON.stringify(settings.output)); return }
    if (o.apply && settings.profile.readOnly === true) fail('此 profile 已显式设为只读')
    const result = await execute(command, o, args, client(settings.profile, spec.name))
    console.log(typeof result === 'string' ? result : JSON.stringify(result))
  } catch (e) {
    console.error(JSON.stringify({ error: errorText(e), ...(e instanceof HttpError && { status: e.status }) }))
    process.exitCode = 1
  }
}
