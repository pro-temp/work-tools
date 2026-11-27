#Requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [hashtable]$Launch,
    [Parameter(Mandatory)] [string]$WorkDir,
    [Parameter(Mandatory)] [string]$SessionId,
    [string]$InitialPrompt,
    [switch]$KeepSection
)

$ErrorActionPreference = 'Stop'

function Get-DispatchTitle([string]$Text) {
    $firstLine = ($Text.Trim() -split '\r\n?|\n', 2)[0]
    $title = ($firstLine -replace '^#{1,6}\s+', '' -replace '^(?:任务书|任务)\s*[:：]\s*', '').Replace('`', '').Trim()
    $elements = [Globalization.StringInfo]::new($title)
    if ($elements.LengthInTextElements -le 80) { return $title }
    return $elements.SubstringByTextElements(0, 79).TrimEnd() + '…'
}

function Invoke-AppServerRequest([string]$Method, [hashtable]$Params) {
    $request = @{ jsonrpc = '2.0'; id = $Method; method = $Method; params = $Params } | ConvertTo-Json -Depth 5 -Compress
    $server.StandardInput.WriteLine($request)
    while ($true) {
        $line = $server.StandardOutput.ReadLineAsync().WaitAsync($deadline.Token).GetAwaiter().GetResult()
        if ($null -eq $line) {
            $detail = $stderrTask.WaitAsync($deadline.Token).GetAwaiter().GetResult().Trim()
            throw "Codex App Server closed during $Method. $detail"
        }
        $reply = $line | ConvertFrom-Json
        if ($reply.id -cne $Method) { continue }
        # A new rollout can exist briefly before it is readable through App Server.
        if ($Method -eq 'thread/read' -and $reply.error -and (
            ($reply.error.code -eq -32600 -and $reply.error.message -ceq "thread not loaded: $SessionId") -or
            $reply.error.message -like "*rollout at *-$SessionId.jsonl is empty"
        )) {
            if ($deadline.Token.WaitHandle.WaitOne(500)) { return $null }
            $server.StandardInput.WriteLine($request)
            continue
        }
        if ($reply.error) { throw "$Method failed: $($reply.error.message)" }
        return $reply.result
    }
}

$start = [Diagnostics.ProcessStartInfo]::new($Launch.FilePath)
$start.WorkingDirectory = $WorkDir
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$start.StandardOutputEncoding = [Text.Encoding]::UTF8
$start.StandardErrorEncoding = [Text.Encoding]::UTF8
foreach ($arg in $Launch.PrefixArgs + @('app-server', '--listen', 'stdio://')) {
    $start.ArgumentList.Add($arg)
}

$sectionName = 'Codex 派单'
$sectionPipeName = 'codex-loop-dispatch-section'
$sectionPipe = $null
$deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(20))
$server = $null
try {
    $server = [Diagnostics.Process]::Start($start)
    $stderrTask = $server.StandardError.ReadToEndAsync()
    Invoke-AppServerRequest 'initialize' @{
        clientInfo = @{ name = 'codex_loop'; version = '1.0' }
        capabilities = @{ experimentalApi = $true }
    } | Out-Null
    $server.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"initialized"}')

    $thread = (Invoke-AppServerRequest 'thread/read' @{ threadId = $SessionId; includeTurns = $false }).thread
    if ($null -eq $thread) { return }
    $entry = @{ Title = $thread.name; TitleError = $null }
    if (-not $entry.Title) {
        $title = Get-DispatchTitle ($InitialPrompt ? $InitialPrompt : $thread.preview)
        if ($title) {
            try {
                Invoke-AppServerRequest 'thread/name/set' @{ threadId = $SessionId; name = $title } | Out-Null
                $entry.Title = $title
            } catch [Management.Automation.PipelineStoppedException] {
                throw
            } catch {
                $entry.TitleError = $_.Exception.Message
            }
        }
    }
    if ($KeepSection -or $thread.section) { return $entry }

    # Share the exact same OS Named Pipe lock with app-server-runner.mjs so concurrent exec + app-server runs serialize section creation/pinning.
    while ($null -eq $sectionPipe) {
        try {
            $sectionPipe = [System.IO.Pipes.NamedPipeServerStream]::new($sectionPipeName, [System.IO.Pipes.PipeDirection]::InOut, 1)
        } catch [System.UnauthorizedAccessException], [System.IO.IOException] {
            if ($deadline.Token.WaitHandle.WaitOne(35)) {
                throw 'Timed out waiting to register the Codex sidebar section.'
            }
        }
    }

    $cursor = $null
    do {
        $page = Invoke-AppServerRequest 'threadSection/list' @{ cursor = $cursor; limit = 100 }
        $section = $page.data | Where-Object { $_.name -ceq $sectionName } | Select-Object -First 1
        $cursor = $page.nextCursor
    } while (-not $section -and $cursor)
    $firstId = $null
    if ($section) {
        # Match the desktop section list. The default source filter omits exec threads.
        $members = Invoke-AppServerRequest 'thread/list' @{
            sectionId = $section.id; sortKey = 'section_position'; limit = 1
            modelProviders = @(); useStateDbOnly = $true
            sourceKinds = @('cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown')
        }
        $firstId = ($members.data | Select-Object -First 1).id
        if ($firstId -eq $SessionId) { return $entry }
    } else {
        $section = (Invoke-AppServerRequest 'threadSection/create' @{ name = $sectionName }).section
    }
    $move = @{ threadId = $SessionId; sectionId = $section.id; beforeThreadId = $firstId }
    try {
        Invoke-AppServerRequest 'thread/section/move' $move | Out-Null
    } catch {
        # A desktop user can move the first thread between the list and move requests.
        if ($_.Exception.Message -cne "thread/section/move failed: before thread $firstId is not in section $($section.id)") { throw }
        $move.beforeThreadId = $null
        Invoke-AppServerRequest 'thread/section/move' $move | Out-Null
    }
    return $entry
} catch [OperationCanceledException] {
    throw 'Codex App Server timed out during sidebar registration.'
} finally {
    if ($sectionPipe) { $sectionPipe.Dispose() }
    $deadline.Dispose()
    if ($server) {
        try {
            $server.StandardInput.Close()
        } finally {
            if (-not $server.WaitForExit(1000)) { $server.Kill($true) }
            $server.Dispose()
        }
    }
}
