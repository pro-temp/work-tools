#Requires -Version 7
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkDir,

    [string]$Prompt,

    [string]$PromptFile,

    [string]$SessionId,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'ultra', 'max')]
    [string]$ReasoningEffort,

    [ValidateSet('implement', 'plan', 'review')]
    [string]$TaskKind = 'implement',

    [ValidateSet('yolo', 'workspace', 'auto', 'readonly')]
    [string]$Mode = 'yolo',

    [string[]]$AddDir,

    [string]$Model,

    [string]$ServiceTier,

    [string]$RunDir,

    [switch]$CaptureBaseline,
    [switch]$ReportStartup
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$resolvedWorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$skillRoot = Split-Path -Parent $PSScriptRoot
$schemaFile = Join-Path $skillRoot 'references\codex-handoff.schema.json'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }

if (-not (Test-Path -LiteralPath $schemaFile -PathType Leaf)) {
    throw "Schema file not found: $schemaFile"
}

if ([string]::IsNullOrEmpty($Prompt) -and [string]::IsNullOrEmpty($PromptFile)) {
    throw 'Either -Prompt or -PromptFile must be provided.'
}

$sourcePromptFile = $null
$promptText = if (-not [string]::IsNullOrEmpty($PromptFile)) {
    $sourcePromptFile = (Resolve-Path -LiteralPath $PromptFile).Path
    [System.IO.File]::ReadAllText($sourcePromptFile, $utf8NoBom)
} else {
    $Prompt
}

$appDataDir = if ($env:ANTIGRAVITY_APP_DATA_DIR) { $env:ANTIGRAVITY_APP_DATA_DIR } else { Join-Path $HOME '.gemini\antigravity' }
$agConversationId = if ($env:ANTIGRAVITY_CONVERSATION_ID) { $env:ANTIGRAVITY_CONVERSATION_ID } else { $null }
$runIndexFile = Join-Path $appDataDir 'codex-loop\runs.json'

$defaultRunsRoot = Join-Path $env:TEMP 'codex-loop'
$defaultDirMarker = '.codex-loop-default'

function Get-PromptTitle([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    foreach ($line in ($Text -split '\r?\n')) {
        $trimmed = $line.Trim()
        if ($trimmed) {
            $clean = ($trimmed -replace '^#+\s*', '').Trim()
            if ($clean.Length -gt 120) { return $clean.Substring(0, 120) }
            return $clean
        }
    }
    return $null
}

function Get-FinishedDefaultDirInfo([string]$Dir, [datetime]$RecentGuardUtc) {
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $defaultDirMarker) -PathType Leaf)) {
        return $null
    }
    $statusFiles = @(Get-ChildItem -LiteralPath $Dir -File -Filter '*.status.json' -ErrorAction SilentlyContinue)
    if ($statusFiles.Count -eq 0) { return $null }

    $latestUtc = [datetime]::MinValue
    foreach ($f in $statusFiles) {
        if ($f.LastWriteTimeUtc -gt $RecentGuardUtc) { return $null }
        try {
            $fs = [IO.FileStream]::new($f.FullName, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            $reader = [IO.StreamReader]::new($fs, $utf8NoBom)
            try { $raw = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $st = $raw | ConvertFrom-Json -ErrorAction Stop
        } catch {
            # Unreadable or partially written status file: fail safe and keep the directory.
            return $null
        }
        if ($st.state -eq 'running') {
            foreach ($pidVal in @($st.runner_pid, $st.cli_pid)) {
                if ($pidVal -and (Get-Process -Id ([int]$pidVal) -ErrorAction SilentlyContinue)) {
                    return $null
                }
            }
            if ($f.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddMinutes(-10)) {
                return $null
            }
        }
        $ts = $f.LastWriteTimeUtc
        foreach ($iso in @($st.finished_at, $st.started_at)) {
            if ($iso) {
                $parsed = [datetimeoffset]::MinValue
                if ([datetimeoffset]::TryParse("$iso", [ref]$parsed)) {
                    if ($parsed.UtcDateTime -gt $ts) { $ts = $parsed.UtcDateTime }
                    break
                }
            }
        }
        if ($ts -gt $latestUtc) { $latestUtc = $ts }
    }
    return [pscustomobject]@{ Path = $Dir; LatestUtc = $latestUtc }
}

function Remove-ExpiredDefaultRunDirs([string]$Root, [int]$MaxAgeDays = 14, [int]$MaxKeep = 50) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-$MaxAgeDays)
    $recentGuard = (Get-Date).ToUniversalTime().AddMinutes(-5)
    $eligible = [System.Collections.Generic.List[object]]::new()

    foreach ($d in (Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        if ($d.LastWriteTimeUtc -gt $recentGuard) { continue }
        $info = Get-FinishedDefaultDirInfo $d.FullName $recentGuard
        if ($info) { $eligible.Add($info) }
    }

    $sorted = @($eligible | Sort-Object LatestUtc -Descending)
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $item = $sorted[$i]
        if ($i -lt $MaxKeep -and $item.LatestUtc -ge $cutoff) { continue }
        try { Remove-Item -LiteralPath $item.Path -Recurse -Force -ErrorAction Stop } catch {}
    }
}

function Write-FileAtomic([string]$Path, [string]$Content) {
    $tmp = "$Path.$PID.$([Guid]::NewGuid().ToString('N').Substring(0, 6)).tmp"
    [System.IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)
    try {
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            try {
                [System.IO.File]::Move($tmp, $Path, $true)
                return
            } catch [System.IO.IOException] {
                if ($attempt -eq 5) { throw }
                Start-Sleep -Milliseconds 25
            }
        }
    } finally {
        if (Test-Path -LiteralPath $tmp -PathType Leaf) {
            try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Update-RunIndex($Obj, [bool]$IsFinal = $false) {
    # Decouple from standalone/non-AGY shells: only write AGY viewer index when invoked under Antigravity.
    if (-not $env:ANTIGRAVITY_APP_DATA_DIR -and -not $env:ANTIGRAVITY_CONVERSATION_ID) {
        return
    }
    $mutex = $null
    $acquired = $false
    try {
        $indexDir = Split-Path -Parent $runIndexFile
        New-Item -ItemType Directory -Force -Path $indexDir | Out-Null
        $mutex = [System.Threading.Mutex]::new($false, 'Local\CodexLoopRunsIndex')
        $waitMs = if ($IsFinal) { 5000 } else { 2000 }
        try {
            $acquired = $mutex.WaitOne($waitMs)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            if ($IsFinal) { [Console]::Error.WriteLine('WARN: codex-loop viewer index lock timeout; runs.json not updated.') }
            return
        }

        $items = [System.Collections.Generic.List[object]]::new()
        if (Test-Path -LiteralPath $runIndexFile -PathType Leaf) {
            try {
                $rawIndex = [System.IO.File]::ReadAllText($runIndexFile, $utf8NoBom)
                if ([string]::IsNullOrWhiteSpace($rawIndex)) {
                    throw [InvalidOperationException]::new('Existing index file is blank.')
                }
                $parsed = $rawIndex | ConvertFrom-Json -ErrorAction Stop
                $arr = if ($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])) { @($parsed) } else { @($parsed) }
                foreach ($it in $arr) {
                    if ($null -eq $it -or [string]::IsNullOrWhiteSpace("$($it.run_dir)")) {
                        throw [InvalidOperationException]::new('Existing index contains malformed entry without run_dir.')
                    }
                    $items.Add($it)
                }
            } catch {
                # Never clobber an existing index file if it cannot be read or validated cleanly.
                if ($IsFinal) { [Console]::Error.WriteLine("WARN: codex-loop viewer index unreadable ($($_.Exception.Message)); keeping existing runs.json.") }
                return
            }
        }

        $key = "$($Obj.run_dir)".ToLowerInvariant()
        $existing = $null
        for ($i = $items.Count - 1; $i -ge 0; $i--) {
            if ("$($items[$i].run_dir)".ToLowerInvariant() -eq $key) {
                $existing = $items[$i]
                $items.RemoveAt($i)
            }
        }

        # Maintain paired confirmed sessions so multi-session RunDirs keep every valid rollout and never mix IDs/paths.
        $sessionMap = [ordered]@{}
        if ($existing) {
            $prevSessions = if ($existing.sessions) { @($existing.sessions) } elseif ($existing.session_id) {
                @([ordered]@{ session_id = $existing.session_id; desktop_url = $existing.desktop_url; native_session = $existing.native_session })
            } else { @() }
            foreach ($s in $prevSessions) {
                if (-not $s -or -not $s.session_id) { continue }
                $sk = "$($s.session_id)".ToLowerInvariant()
                $sessionMap[$sk] = [ordered]@{
                    session_id     = $sk
                    desktop_url    = if ($s.desktop_url) { $s.desktop_url } else { "codex://threads/$sk" }
                    native_session = $s.native_session
                }
            }
        }

        $isConfirmedSession = $Obj.session_id -and ($Obj.error_kind -ne 'invalid_session') -and (
            $Obj.desktop_url -or $Obj.native_session -or $Obj.sidebar_registered -or $Obj.state -eq 'finished'
        )
        if ($isConfirmedSession) {
            $sk = "$($Obj.session_id)".ToLowerInvariant()
            $prevRec = if ($sessionMap.Contains($sk)) { $sessionMap[$sk] } else { $null }
            if ($sessionMap.Contains($sk)) { $sessionMap.Remove($sk) }
            $sessionMap[$sk] = [ordered]@{
                session_id     = $sk
                desktop_url    = if ($Obj.desktop_url) { $Obj.desktop_url } elseif ($prevRec -and $prevRec.desktop_url) { $prevRec.desktop_url } else { "codex://threads/$sk" }
                native_session = if ($Obj.native_session) { $Obj.native_session } elseif ($prevRec) { $prevRec.native_session } else { $null }
            }
        }

        $sessionsList = @($sessionMap.Values)
        $latestSession = if ($sessionsList.Count -gt 0) { $sessionsList[$sessionsList.Count - 1] } else { $null }

        $title = if ($Obj.sidebar_title) {
            $Obj.sidebar_title
        } elseif ($existing -and $existing.title) {
            $existing.title
        } else {
            Get-PromptTitle $promptText
        }

        $entry = [ordered]@{
            run_dir            = $Obj.run_dir
            work_dir           = $Obj.work_dir
            conversation_id    = if ($Obj.conversation_id) { $Obj.conversation_id } elseif ($existing) { $existing.conversation_id } else { $null }
            session_id         = if ($latestSession) { $latestSession.session_id } else { $null }
            desktop_url        = if ($latestSession) { $latestSession.desktop_url } else { $null }
            native_session     = if ($latestSession) { $latestSession.native_session } else { $null }
            sessions           = $sessionsList
            title              = $title
            task_kind          = $Obj.task_kind
            state              = $Obj.state
            started_at         = if ($existing -and $existing.started_at) { $existing.started_at } else { $Obj.started_at }
            updated_at         = (Get-Date).ToString('o')
            latest_status_file = $Obj.status_file
        }
        $items.Insert(0, $entry)

        # Normalize updated_at to DateTimeOffset UTC so ConvertFrom-Json DateTime and ISO strings sort identically.
        $capped = @($items | Sort-Object {
            $dto = [datetimeoffset]::MinValue
            if ($_.updated_at -is [datetime]) { [datetimeoffset]::new($_.updated_at).UtcDateTime }
            elseif ($_.updated_at -and [datetimeoffset]::TryParse("$($_.updated_at)", [ref]$dto)) { $dto.UtcDateTime }
            else { [datetime]::MinValue }
        } -Descending | Select-Object -First 200)
        Write-FileAtomic $runIndexFile (ConvertTo-Json -InputObject $capped -Depth 6)
    } catch {
        # Best-effort viewer index update; never fail the primary Codex dispatch on index I/O contention.
        if ($IsFinal) { [Console]::Error.WriteLine("WARN: codex-loop viewer index update skipped ($($_.Exception.Message)).") }
    } finally {
        if ($acquired -and $mutex) {
            try { $mutex.ReleaseMutex() } catch {}
        }
        if ($mutex) { $mutex.Dispose() }
    }
}

$isResume = -not [string]::IsNullOrWhiteSpace($SessionId)
$taskKindExplicit = $PSBoundParameters.ContainsKey('TaskKind')
$modeExplicit = $PSBoundParameters.ContainsKey('Mode')
$usingDefaultRunDir = [string]::IsNullOrWhiteSpace($RunDir)

$defaultMutex = $null
$defaultLockHeld = $false
try {
    $needsDefaultLock = $usingDefaultRunDir -or ([System.IO.Path]::GetFullPath($RunDir).StartsWith([System.IO.Path]::GetFullPath($defaultRunsRoot), [StringComparison]::OrdinalIgnoreCase))
    if ($needsDefaultLock) {
        $defaultMutex = [System.Threading.Mutex]::new($false, 'Local\CodexLoopDefaultRuns')
        try { $defaultLockHeld = $defaultMutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $defaultLockHeld = $true }
        if (-not $defaultLockHeld -and -not $usingDefaultRunDir) {
            throw "Timed out waiting for default run directory lock before resuming in $RunDir."
        }
    }
    if ($usingDefaultRunDir) {
        if ($defaultLockHeld) { Remove-ExpiredDefaultRunDirs $defaultRunsRoot }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $shortId = [Guid]::NewGuid().ToString('N').Substring(0, 6)
        $RunDir = Join-Path $defaultRunsRoot "$stamp-$shortId"
    }
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    $RunDir = (Resolve-Path -LiteralPath $RunDir).Path
    $turnPrefix = if ($isResume) { 'resume' } else { 'initial' }
    $turnTag = "$turnPrefix-$(Get-Date -Format 'HHmmss-fff')-$([Guid]::NewGuid().ToString('N').Substring(0, 4))"
    $promptOutFile = Join-Path $RunDir "$turnTag.prompt.txt"
    [System.IO.File]::WriteAllText($promptOutFile, $promptText, $utf8NoBom)
    $eventsFile = Join-Path $RunDir "$turnTag.events.jsonl"
    $handoffFile = Join-Path $RunDir "$turnTag.handoff.json"
    $stderrFile = Join-Path $RunDir "$turnTag.stderr.txt"
    $statusFile = Join-Path $RunDir "$turnTag.status.json"
    # Publish a minimal active running status before releasing the cleanup lock so concurrent cleanup can never delete this dir.
    $bootStatus = [ordered]@{ state = 'running'; runner_pid = $PID; started_at = (Get-Date).ToString('o') }
    Write-FileAtomic $statusFile ($bootStatus | ConvertTo-Json -Compress)
    if ($usingDefaultRunDir) {
        [System.IO.File]::WriteAllText((Join-Path $RunDir $defaultDirMarker), (Get-Date).ToString('o'), $utf8NoBom)
    }
} finally {
    if ($defaultLockHeld -and $defaultMutex) { try { $defaultMutex.ReleaseMutex() } catch {} }
    if ($defaultMutex) { $defaultMutex.Dispose() }
}
if ($ReportStartup) {
    $startup = [ordered]@{ runner_pid = $PID; status_file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($statusFile) }
    [Console]::Error.WriteLine("CODEX_STARTUP " + ($startup | ConvertTo-Json -Compress))
}

function Resolve-CodexLaunch {
    $directExe = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($directExe) {
        return @{ FilePath = $directExe.Source; PrefixArgs = @() }
    }

    $shim = Get-Command codex -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -like '*.ps1' -or $_.Source -like '*.cmd' } |
        Select-Object -First 1
    if ($shim) {
        $baseDir = Split-Path -Parent $shim.Source
        $archDir = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') {
            @{ pkg = 'codex-win32-arm64'; triple = 'aarch64-pc-windows-msvc' }
        } else {
            @{ pkg = 'codex-win32-x64'; triple = 'x86_64-pc-windows-msvc' }
        }
        $vendorExe = Join-Path $baseDir "node_modules\@openai\codex\node_modules\@openai\$($archDir.pkg)\vendor\$($archDir.triple)\bin\codex.exe"
        if (Test-Path -LiteralPath $vendorExe -PathType Leaf) {
            return @{ FilePath = $vendorExe; PrefixArgs = @() }
        }
        $codexJs = Join-Path $baseDir 'node_modules\@openai\codex\bin\codex.js'
        if (Test-Path -LiteralPath $codexJs -PathType Leaf) {
            $nodeExe = Join-Path $baseDir 'node.exe'
            if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
                $nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
            }
            return @{ FilePath = $nodeExe; PrefixArgs = @($codexJs) }
        }
    }

    throw 'Unable to locate codex.exe or npm @openai/codex entrypoint in PATH.'
}

function Get-CodexCliVersion([hashtable]$Launch) {
    try {
        $psi = [Diagnostics.ProcessStartInfo]::new($Launch.FilePath)
        foreach ($a in $Launch.PrefixArgs) { $psi.ArgumentList.Add($a) }
        $psi.ArgumentList.Add('--version')
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [Diagnostics.Process]::Start($psi)
        $outTask = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit(10000)) {
            $p.Kill($true)
            return $null
        }
        $line = ($outTask.Result -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
        if ($line) { $line.Trim() } else { $null }
    } catch {
        $null
    }
}

function Find-CodexSessionFile([string]$Id) {
    if ($Id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        return $null
    }
    foreach ($sub in 'sessions', 'archived_sessions') {
        $root = Join-Path $codexHome $sub
        if (Test-Path -LiteralPath $root -PathType Container) {
            $file = Get-ChildItem -LiteralPath $root -Recurse -File -Filter "rollout-*-$Id.jsonl*" -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($file) { return $file }
        }
    }
    return $null
}

function Get-PersistedRolloutPath([IO.FileInfo]$File) {
    if ($File) {
        $File.Refresh()
        if ($File.Exists -and $File.Length -gt 0) { return $File.FullName }
    }
}

function Read-SharedText([string]$Path, [long]$MaxBytes, [switch]$Tail) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $stream = [IO.FileStream]::new($Path, 'Open', 'Read', 'ReadWrite')
    try {
        if ($Tail) { $stream.Position = [Math]::Max(0, $stream.Length - $MaxBytes) }
        $toRead = [int][Math]::Min($MaxBytes, $stream.Length - $stream.Position)
        if ($toRead -le 0) { return '' }
        $buffer = [byte[]]::new($toRead)
        $count = $stream.Read($buffer, 0, $toRead)
        return $utf8NoBom.GetString($buffer, 0, $count)
    } finally {
        $stream.Dispose()
    }
}

function Read-EffectiveFromRollout([string]$Path) {
    $eff = [ordered]@{
        workdir      = $null
        model        = $null
        effort       = $null
        service_tier = $null
        approval     = $null
        sandbox      = $null
    }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $eff }

    $reader = [IO.StreamReader]::new([IO.FileStream]::new($Path, 'Open', 'Read', 'ReadWrite'), $utf8NoBom)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            if ($line.Contains('"type":"turn_context"')) {
                try {
                    $p = ($line | ConvertFrom-Json -ErrorAction Stop).payload
                    if ($p.cwd) { $eff.workdir = $p.cwd }
                    if ($p.model) { $eff.model = $p.model }
                    if ($p.effort) { $eff.effort = $p.effort }
                    if ($p.approval_policy) { $eff.approval = $p.approval_policy }
                    if ($p.sandbox_policy -and $p.sandbox_policy.type) { $eff.sandbox = $p.sandbox_policy.type }
                } catch {}
            } elseif ($line.Contains('"type":"thread_settings_applied"')) {
                try {
                    $ts = ($line | ConvertFrom-Json -ErrorAction Stop).payload.thread_settings
                    if ($ts.model) { $eff.model = $ts.model }
                    if ($ts.reasoning_effort) { $eff.effort = $ts.reasoning_effort }
                    if ($ts.service_tier) { $eff.service_tier = $ts.service_tier }
                    if ($ts.approval_policy) { $eff.approval = $ts.approval_policy }
                } catch {}
            }
        }
    } finally {
        $reader.Dispose()
    }
    return $eff
}

function Find-PreviousSessionStatus([string]$Dir, [string]$Id) {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $null }
    $files = Get-ChildItem -LiteralPath $Dir -File -Filter '*.status.json' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending
    foreach ($f in $files) {
        if ($f.FullName -eq $statusFile) { continue }
        try {
            $obj = [System.IO.File]::ReadAllText($f.FullName, $utf8NoBom) | ConvertFrom-Json -ErrorAction Stop
            if ($obj.session_id -eq $Id) { return $obj }
        } catch {}
    }
    return $null
}

function Save-Status($Obj) {
    # A resume can find the old rollout even when another writer prevents this attempt from starting.
    if ($Obj.native_session -and -not $Obj.desktop_url -and ($threadStarted -or $Obj.state -ne 'running')) {
        $Obj.desktop_url = "codex://threads/$($Obj.session_id)"
        if ($ReportStartup -and $threadStarted -and $Obj.state -in 'running', 'finished') {
            [Console]::Error.WriteLine("CODEX_DESKTOP_URL=$($Obj.desktop_url)")
        }
    }
    $json = $Obj | ConvertTo-Json -Depth 12
    Write-FileAtomic $statusFile $json
    Update-RunIndex $Obj ($Obj.state -ne 'running')
    return $json
}

function Exit-PreflightFailure([string]$ErrorKind, [string]$Message) {
    $status.state = 'failed'
    $status.exit_code = 1
    $status.error_kind = $ErrorKind
    $status.errors = @($Message)
    $status.finished_at = (Get-Date).ToString('o')
    $json = Save-Status $status
    Write-Output $json
    exit 1
}

function Register-DesktopThread {
    try {
        $initialPrompt = if (-not $isResume) { $promptText }
        $entry = & (Join-Path $PSScriptRoot 'add-sidebar-thread.ps1') -Launch $launch -WorkDir $resolvedWorkDir `
            -SessionId $status.session_id -InitialPrompt $initialPrompt -KeepSection:$status.sidebar_registered
        if ($null -eq $entry) {
            $status.sidebar_error = 'Codex App Server cannot read the new rollout yet.'
            return $false
        }
        $status.sidebar_registered = $true
        $status.sidebar_title = $entry.Title
        $status.sidebar_error = $entry.TitleError
    } catch [Management.Automation.PipelineStoppedException] {
        throw
    } catch {
        $status.sidebar_error = $_.Exception.Message
    }
    return $true
}

$launch = Resolve-CodexLaunch
$cliVersion = Get-CodexCliVersion $launch

$isGitRepo = $false
Push-Location -LiteralPath $resolvedWorkDir
try {
    $gitCheck = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and "$gitCheck".Trim() -eq 'true') { $isGitRepo = $true }
} catch {
    $isGitRepo = $false
} finally {
    Pop-Location
}

$status = [ordered]@{
    state                = 'running'
    exit_code            = $null
    mode                 = if ($isResume) { 'resume' } else { 'exec' }
    task_kind            = $TaskKind
    requested_mode       = $Mode
    requested_add_dir    = @()
    requested_effort     = if ($ReasoningEffort) { $ReasoningEffort } else { $null }
    requested_model      = if ($Model) { $Model } else { $null }
    requested_tier       = if ($ServiceTier) { $ServiceTier } else { $null }
    session_id           = if ($isResume) { $SessionId } else { $null }
    desktop_url          = $null
    sidebar_registered   = $false
    sidebar_title        = $null
    sidebar_error        = $null
    native_session       = $null
    runner_pid           = $PID
    cli_pid              = $null
    cli_path             = $launch.FilePath
    cli_version          = $cliVersion
    started_at           = (Get-Date).ToString('o')
    finished_at          = $null
    work_dir             = $resolvedWorkDir
    is_git_repo          = $isGitRepo
    conversation_id      = $agConversationId
    run_dir              = $RunDir
    prompt_file          = $promptOutFile
    source_prompt_file   = $sourcePromptFile
    status_file          = $statusFile
    handoff_file         = $handoffFile
    events_file          = $eventsFile
    stderr_file          = $stderrFile
    baseline_head_file   = $null
    baseline_status_file = $null
    baseline_diff_file   = $null
    baseline_cached_file = $null
    effective            = $null
    usage                = $null
    error_kind           = $null
    errors               = @()
    stderr_preview       = ''
    handoff              = $null
    handoff_raw_preview  = $null
}

$threadStarted = $false
$rolloutFile = $null
# Pre-validate resume session existence: Codex silently spawns a blank session for missing IDs.
if ($isResume) {
    $rolloutFile = Find-CodexSessionFile $SessionId
    if (-not $rolloutFile) {
        Exit-PreflightFailure 'invalid_session' "Resume session not found or invalid UUID: $SessionId (checked $codexHome\sessions and archived_sessions); Codex was not started."
    }
    $status.native_session = Get-PersistedRolloutPath $rolloutFile

    # Inherit previous TaskKind, Mode, and overrides on resume unless explicitly specified.
    $prevStatus = Find-PreviousSessionStatus $RunDir $SessionId
    if ($prevStatus) {
        $status.sidebar_registered = [bool]$prevStatus.sidebar_registered
        $status.sidebar_title = $prevStatus.sidebar_title
    }
    if (-not $taskKindExplicit -and $prevStatus -and $prevStatus.task_kind) {
        $TaskKind = "$($prevStatus.task_kind)"
    }
    $status.task_kind = $TaskKind

    if ($TaskKind -in 'plan', 'review') {
        if ($modeExplicit -and $Mode -ne 'readonly') {
            $status.requested_mode = $Mode
            Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' requires -Mode readonly (received -Mode '$Mode'); Codex was not started."
        }
        $Mode = 'readonly'
    } elseif (-not $modeExplicit) {
        if ($prevStatus -and $prevStatus.requested_mode) {
            $Mode = "$($prevStatus.requested_mode)"
        } else {
            $prevEff = Read-EffectiveFromRollout $rolloutFile.FullName
            if ($prevEff.sandbox -eq 'read-only') {
                $Mode = 'readonly'
            } elseif ($prevEff.sandbox -eq 'workspace-write' -and $prevEff.approval -eq 'on-request') {
                $Mode = 'auto'
            } elseif ($prevEff.sandbox -eq 'workspace-write') {
                $Mode = 'workspace'
            } elseif ($prevEff.sandbox -eq 'danger-full-access') {
                $Mode = 'yolo'
            } else {
                $status.requested_mode = $null
                Exit-PreflightFailure 'unknown_resume_mode' "Unable to infer previous -Mode for session $SessionId (no matching status in RunDir and unrecognized rollout sandbox policy); pass -Mode explicitly."
            }
        }
    }
    if (-not $PSBoundParameters.ContainsKey('AddDir') -and $prevStatus -and $prevStatus.requested_add_dir) {
        $prevDirs = @($prevStatus.requested_add_dir | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") })
        if ($prevDirs.Count -gt 0) { $AddDir = $prevDirs }
    }
    if (-not $PSBoundParameters.ContainsKey('Model') -and $prevStatus -and $prevStatus.requested_model) {
        $Model = "$($prevStatus.requested_model)"
    }
    if (-not $PSBoundParameters.ContainsKey('ReasoningEffort') -and $prevStatus -and $prevStatus.requested_effort) {
        $ReasoningEffort = "$($prevStatus.requested_effort)"
    }
    if (-not $PSBoundParameters.ContainsKey('ServiceTier') -and $prevStatus -and $prevStatus.requested_tier) {
        $ServiceTier = "$($prevStatus.requested_tier)"
    }
    $status.requested_model = if ($Model) { $Model } else { $null }
    $status.requested_effort = if ($ReasoningEffort) { $ReasoningEffort } else { $null }
    $status.requested_tier = if ($ServiceTier) { $ServiceTier } else { $null }
} elseif ($TaskKind -in 'plan', 'review') {
    if ($modeExplicit -and $Mode -ne 'readonly') {
        $status.requested_mode = $Mode
        Exit-PreflightFailure 'invalid_arguments' "TaskKind '$TaskKind' requires -Mode readonly (received -Mode '$Mode'); Codex was not started."
    }
    $Mode = 'readonly'
}
$status.task_kind = $TaskKind
$status.requested_mode = $Mode

$resolvedAddDirs = @()
if ($AddDir -and $AddDir.Count -gt 0) {
    $resolvedAddDirs = @($AddDir | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
}
$status.requested_add_dir = $resolvedAddDirs

if ($CaptureBaseline) {
    Push-Location -LiteralPath $resolvedWorkDir
    try {
        if ($isGitRepo) {
            $status.baseline_head_file = Join-Path $RunDir 'baseline.head.txt'
            $status.baseline_status_file = Join-Path $RunDir 'baseline.status.txt'
            $status.baseline_diff_file = Join-Path $RunDir 'baseline.diff.patch'
            $status.baseline_cached_file = Join-Path $RunDir 'baseline.cached.patch'
            # Preserve the first-round baseline when reusing RunDir (e.g. opening a new session after active_writer).
            $hasExistingBaseline = (Test-Path -LiteralPath $status.baseline_head_file -PathType Leaf) -and
                (Test-Path -LiteralPath $status.baseline_status_file -PathType Leaf) -and
                (Test-Path -LiteralPath $status.baseline_diff_file -PathType Leaf) -and
                (Test-Path -LiteralPath $status.baseline_cached_file -PathType Leaf)
            if (-not $hasExistingBaseline) {
                $headSha = git rev-parse HEAD 2>$null
                $headOut = if ($LASTEXITCODE -eq 0 -and $headSha) { "$headSha".Trim() } else { '' }
                [System.IO.File]::WriteAllText($status.baseline_head_file, $headOut, $utf8NoBom)
                $statusLines = git status --porcelain 2>$null
                [System.IO.File]::WriteAllLines($status.baseline_status_file, @($statusLines), $utf8NoBom)
                $diffLines = git diff 2>$null
                [System.IO.File]::WriteAllLines($status.baseline_diff_file, @($diffLines), $utf8NoBom)
                $cachedLines = git diff --cached 2>$null
                [System.IO.File]::WriteAllLines($status.baseline_cached_file, @($cachedLines), $utf8NoBom)
            }
        } else {
            $status.baseline_status_file = Join-Path $RunDir 'baseline.files.txt'
            if (-not (Test-Path -LiteralPath $status.baseline_status_file -PathType Leaf)) {
                $fileLines = Get-ChildItem -LiteralPath $resolvedWorkDir -Recurse -File -ErrorAction SilentlyContinue |
                    ForEach-Object { "$($_.LastWriteTimeUtc.ToString('o'))|$($_.Length)|$($_.FullName)" }
                [System.IO.File]::WriteAllLines($status.baseline_status_file, @($fileLines), $utf8NoBom)
            }
        }
    } finally {
        Pop-Location
    }
}

$codexArgs = [System.Collections.Generic.List[string]]::new()
foreach ($a in $launch.PrefixArgs) { $codexArgs.Add($a) }
$codexArgs.Add('exec')

# Parent-level exec flags (work for both new sessions and resume)
if ($Mode -eq 'yolo') {
    $codexArgs.Add('--yolo')
} elseif ($Mode -eq 'auto' -and -not $isResume) {
    $codexArgs.Add('--approve-for-me')
} elseif ($Mode -eq 'workspace' -and -not $isResume) {
    $codexArgs.Add('-s')
    $codexArgs.Add('workspace-write')
} elseif ($Mode -eq 'readonly' -and -not $isResume) {
    $codexArgs.Add('-s')
    $codexArgs.Add('read-only')
}

$codexArgs.Add('-C')
$codexArgs.Add($resolvedWorkDir)

if (-not $isGitRepo) {
    $codexArgs.Add('--skip-git-repo-check')
}

if (-not $isResume -and $resolvedAddDirs.Count -gt 0) {
    foreach ($dir in $resolvedAddDirs) {
        $codexArgs.Add('--add-dir')
        $codexArgs.Add($dir)
    }
}

if ($isResume) {
    $codexArgs.Add('resume')
    if ($Mode -eq 'workspace' -or $Mode -eq 'auto') {
        $codexArgs.Add('-c')
        $codexArgs.Add('sandbox_mode="workspace-write"')
        if ($Mode -eq 'workspace') {
            $codexArgs.Add('-c')
            $codexArgs.Add('approval_policy="never"')
        } else {
            $codexArgs.Add('-c')
            $codexArgs.Add('approval_policy="on-request"')
            $codexArgs.Add('-c')
            $codexArgs.Add('approvals_reviewer="auto_review"')
        }
        if ($resolvedAddDirs.Count -gt 0) {
            $escapedDirs = $resolvedAddDirs | ForEach-Object {
                $p = $_.Replace('\', '\\').Replace('"', '\"')
                "`"$p`""
            }
            $codexArgs.Add('-c')
            $codexArgs.Add("sandbox_workspace_write.writable_roots=[$($escapedDirs -join ',')]")
        }
    } elseif ($Mode -eq 'readonly') {
        $codexArgs.Add('-c')
        $codexArgs.Add('sandbox_mode="read-only"')
        $codexArgs.Add('-c')
        $codexArgs.Add('approval_policy="never"')
    }
} elseif ($Mode -eq 'workspace' -or $Mode -eq 'readonly') {
    $codexArgs.Add('-c')
    $codexArgs.Add('approval_policy="never"')
}

if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
    $codexArgs.Add('-c')
    $codexArgs.Add("model_reasoning_effort=`"$ReasoningEffort`"")
}
$codexArgs.Add('-c')
$codexArgs.Add('notify=[]')
$codexArgs.Add('--disable')
$codexArgs.Add('default_mode_request_user_input')

if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $codexArgs.Add('-m')
    $codexArgs.Add($Model)
}

if (-not [string]::IsNullOrWhiteSpace($ServiceTier)) {
    $codexArgs.Add('-c')
    $codexArgs.Add("service_tier=`"$ServiceTier`"")
}

$codexArgs.Add('--output-schema')
$codexArgs.Add($schemaFile)
$codexArgs.Add('--json')
$codexArgs.Add('-o')
$codexArgs.Add($handoffFile)

if ($isResume) {
    $codexArgs.Add($SessionId)
}
$codexArgs.Add('-')

Save-Status $status | Out-Null

$proc = $null
$streams = @()
$copyTasks = @()
$waited = $false

try {
    $psi = [Diagnostics.ProcessStartInfo]::new($launch.FilePath)
    $psi.WorkingDirectory = $resolvedWorkDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardInputEncoding = $utf8NoBom
    # Isolate child process group so finally cleans up the full process tree cleanly via taskkill /T.
    $psi.CreateNewProcessGroup = $true
    foreach ($arg in $codexArgs) { $psi.ArgumentList.Add($arg) }

    $proc = [Diagnostics.Process]::Start($psi)
    $status.cli_pid = $proc.Id
    Save-Status $status | Out-Null

    # Buffer size 1 flushes immediately so live progress logs are readable while running.
    $streams = @(
        [IO.FileStream]::new($eventsFile, 'Create', 'Write', 'ReadWrite', 1),
        [IO.FileStream]::new($stderrFile, 'Create', 'Write', 'ReadWrite', 1)
    )
    $copyTasks = @(
        $proc.StandardOutput.BaseStream.CopyToAsync($streams[0]),
        $proc.StandardError.BaseStream.CopyToAsync($streams[1])
    )

    $proc.StandardInput.Write($promptText)
    $proc.StandardInput.Close()

    $watchStartup = $true
    while (-not $proc.WaitForExit(($threadStarted ? 2000 : 250))) {
        if (-not $watchStartup) { continue }
        try {
            if (-not $threadStarted) {
                $head = Read-SharedText $eventsFile 65536
                $m = [regex]::Match($head, '"type"\s*:\s*"thread\.started"[^}]*"thread_id"\s*:\s*"([0-9a-f-]+)"')
                if (-not $m.Success) { continue }
                $status.session_id = $m.Groups[1].Value
                $threadStarted = $true
                Save-Status $status | Out-Null
            }
            if (-not $status.native_session) {
                $rolloutFile ??= Find-CodexSessionFile $status.session_id
                $status.native_session = Get-PersistedRolloutPath $rolloutFile
            }
            if ($status.native_session) {
                Save-Status $status | Out-Null
                if ($status.sidebar_registered -and $status.sidebar_title) {
                    $watchStartup = $false
                    continue
                }
                $watchStartup = -not (Register-DesktopThread)
                Save-Status $status | Out-Null
            }
        } catch [IO.IOException] {
            # A live log or status file may be temporarily locked by its reader.
            continue
        }
    }
    $proc.WaitForExit()
    $waited = $true
} catch {
    $status.state = 'failed'
    $status.errors = @($_.Exception.Message)
} finally {
    if ($proc -and -not $proc.HasExited) {
        try {
            $killer = [Diagnostics.ProcessStartInfo]::new('taskkill.exe')
            foreach ($karg in @('/PID', "$($proc.Id)", '/T', '/F')) { $killer.ArgumentList.Add($karg) }
            $killer.UseShellExecute = $false
            $killer.CreateNoWindow = $true
            $killer.RedirectStandardOutput = $true
            $killer.RedirectStandardError = $true
            [Diagnostics.Process]::Start($killer).WaitForExit(10000) | Out-Null
            if (-not $proc.WaitForExit(10000)) {
                $proc.Kill($true)
                $proc.WaitForExit(10000) | Out-Null
            }
        } catch {}
    }
    if ($copyTasks.Count -gt 0) {
        try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copyTasks, 10000) | Out-Null } catch {}
    }
    foreach ($s in $streams) { $s.Dispose() }

    $status.exit_code = if ($proc -and $proc.HasExited) { $proc.ExitCode } else { 1 }
    if (-not $waited -and $status.state -eq 'running') { $status.state = 'stopped' }

    $errList = [System.Collections.Generic.List[string]]::new()
    foreach ($e in $status.errors) { $errList.Add($e) }

    if (Test-Path -LiteralPath $eventsFile -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $eventsFile -Encoding utf8) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $ev = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
            if ($ev.type -eq 'thread.started' -and $ev.thread_id) {
                $status.session_id = $ev.thread_id
                $threadStarted = $true
            } elseif ($ev.type -eq 'turn.completed' -and $ev.usage) {
                $status.usage = $ev.usage
            } elseif ($ev.type -eq 'item.completed' -and $ev.item -and $ev.item.type -eq 'error') {
                $msg = "$($ev.item.message)"
                if ($msg -notlike 'Under-development features enabled:*') { $errList.Add($msg) }
            } elseif ($ev.type -eq 'error' -and $ev.message) {
                $errList.Add("$($ev.message)")
            }
        }
    }

    $stderrText = (Read-SharedText $stderrFile 65536 -Tail).Trim()
    $status.stderr_preview = if ($stderrText.Length -gt 800) { $stderrText.Substring(0, 800) } else { $stderrText }
    if ($status.exit_code -ne 0 -and $stderrText) {
        $errMatches = [regex]::Matches($stderrText, '(?im)^error:\s*(.+?)\s*$')
        if ($errMatches.Count -gt 0) {
            $errList.Add($errMatches[$errMatches.Count - 1].Groups[1].Value)
        }
    }
    $status.errors = @($errList | Select-Object -Unique)

    $combinedErr = ($status.errors -join "`n") + "`n" + $stderrText
    if ($combinedErr -match 'already has an active writer') {
        $status.error_kind = 'active_writer'
    } elseif ($combinedErr -match 'at capacity') {
        $status.error_kind = 'capacity'
    }

    if ($status.session_id) {
        if (-not $status.native_session) {
            $rolloutFile ??= Find-CodexSessionFile $status.session_id
            $status.native_session = Get-PersistedRolloutPath $rolloutFile
        }
        if ($status.native_session) {
            $status.effective = Read-EffectiveFromRollout $status.native_session
        }
    }

    if ($status.exit_code -eq 0 -and (Test-Path -LiteralPath $handoffFile -PathType Leaf)) {
        $handoffRaw = [System.IO.File]::ReadAllText($handoffFile, $utf8NoBom)
        if (-not [string]::IsNullOrWhiteSpace($handoffRaw)) {
            try {
                $status.handoff = $handoffRaw | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $status.handoff_raw_preview = if ($handoffRaw.Length -gt 800) { $handoffRaw.Substring(0, 800) } else { $handoffRaw }
            }
        }
    }

    $handoffValid = $null -ne $status.handoff
    if ($handoffValid) {
        $handoffIssues = [System.Collections.Generic.List[string]]::new()
        $h = $status.handoff
        if ($h.status -eq 'needs_input' -and ($null -eq $h.questions -or @($h.questions).Count -eq 0)) {
            $handoffIssues.Add('Invalid handoff: status is "needs_input" but "questions" is empty.')
        }
        if ($h.status -eq 'needs_permission' -and $null -eq $h.permission_request) {
            $handoffIssues.Add('Invalid handoff: status is "needs_permission" but "permission_request" is null.')
        }
        if ($TaskKind -in 'plan', 'review' -and $null -ne $h.changed_files -and @($h.changed_files).Count -gt 0) {
            $handoffIssues.Add("Invalid handoff: TaskKind '$TaskKind' is read-only but 'changed_files' is non-empty.")
        }
        if ($handoffIssues.Count -gt 0) {
            $handoffValid = $false
            foreach ($issue in $handoffIssues) { $errList.Add($issue) }
            $status.errors = @($errList | Select-Object -Unique)
            if (-not $status.error_kind) { $status.error_kind = 'invalid_handoff' }
        }
    }

    if ($status.state -eq 'running') {
        $status.state = if ($status.exit_code -eq 0 -and $handoffValid) { 'finished' } else { 'failed' }
    }
    # Cover short runs and an unsuccessful early attempt. Cancellation must not start a new helper.
    if ($waited -and $status.native_session -and -not ($status.sidebar_registered -and $status.sidebar_title)) {
        Register-DesktopThread | Out-Null
    }
    $status.finished_at = (Get-Date).ToString('o')
    $finalJson = Save-Status $status
}

Write-Output $finalJson
if ($status.state -eq 'finished') { exit 0 } elseif ($status.exit_code) { exit $status.exit_code } else { exit 1 }
