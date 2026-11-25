#Requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$StatusFile,
    [Parameter(Mandatory)] [int]$RunnerPid
)

$ErrorActionPreference = 'Stop'
$runner = Get-Process -Id $RunnerPid -ErrorAction SilentlyContinue
try {
    while ($true) {
        $exited = -not $runner -or $runner.HasExited
        if ([IO.File]::Exists($StatusFile)) {
            # Share writes and delete: the runner atomically replaces the status file while we poll.
            try {
                $reader = [IO.StreamReader]::new([IO.FileStream]::new($StatusFile, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)))
                try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $status = ConvertFrom-Json -InputObject $json -ErrorAction Stop
            } catch [IO.IOException], [ArgumentException] {
                if ($exited) { throw }
                $status = $null
            }
            if ($status.desktop_url -and $status.state -in 'running', 'finished') {
                Write-Output $status.desktop_url
                return
            }
            if ($status -and $status.state -ne 'running') {
                throw "Codex $($status.state) before startup could be confirmed. $($status.errors -join ' ')"
            }
        }
        if ($exited) { throw "Codex runner $RunnerPid exited without publishing a desktop link. Check the dispatch command output." }
        [void]$runner.WaitForExit(250)
    }
} finally {
    if ($runner) { $runner.Dispose() }
}
