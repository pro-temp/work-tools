#Requires -Version 7
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$RunDir,
    [string]$SessionId,
    [string]$AttemptId,

    [ValidateSet('steer', 'interrupt', 'status')]
    [string]$Action = 'steer',

    [string]$Message,
    [string]$MessageFile,
    [string]$Reason,
    [string]$FollowUp,
    [string]$FollowUpFile,
    [string]$ClientMessageId,

    [int]$WaitAppliedMs = 3000,
    [int]$TimeoutSec = 15
)

$Action = $Action.ToLowerInvariant()

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Resolve-NodeLaunch {
    $nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCmd) { return $nodeCmd.Source }
    $agyCmd = Join-Path $env:APPDATA 'Antigravity\bin\agy-node.cmd'
    if ($env:APPDATA -and (Test-Path -LiteralPath $agyCmd -PathType Leaf)) { return $agyCmd }
    throw 'Unable to locate node.exe or agy-node.cmd.'
}

if ($MessageFile) {
    $Message = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $MessageFile).Path, $utf8NoBom)
}
if ($FollowUpFile) {
    $FollowUp = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $FollowUpFile).Path, $utf8NoBom)
}
if ($RunDir -and (Test-Path -LiteralPath $RunDir)) {
    $RunDir = (Resolve-Path -LiteralPath $RunDir).Path
}

$payload = [ordered]@{
    attemptId       = $AttemptId
    runDir          = $RunDir
    sessionId       = $SessionId
    action          = $Action
    message         = $Message
    reason          = $Reason
    followUp        = $FollowUp
    clientMessageId = $ClientMessageId
    waitAppliedMs   = $WaitAppliedMs
    timeoutMs       = ($TimeoutSec * 1000)
}

$node = Resolve-NodeLaunch
$clientScript = Join-Path $PSScriptRoot 'lib\control-client.mjs'
$json = $payload | ConvertTo-Json -Compress -Depth 6
$json | & $node $clientScript
exit $LASTEXITCODE
