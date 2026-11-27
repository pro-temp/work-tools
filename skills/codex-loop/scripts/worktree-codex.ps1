#Requires -Version 7
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('prepare', 'inspect', 'integrate', 'cleanup', 'list')]
    [string]$Action,

    [string]$RepoDir,
    [string]$WorktreePath,
    [string]$BatchId,
    [string]$SubtaskId,
    [string]$BaseRef = 'HEAD',

    [ValidateSet('clean', 'head')]
    [string]$BasePolicy = 'clean',

    [string]$BaseHead,
    [string]$ExpectedMainHead,
    [switch]$AllowHeadDrift,
    [switch]$DryRun,
    [string[]]$LinkDirs,
    [switch]$KeepBranch,
    [switch]$Force,
    [string]$WorktreeRoot
)

$Action = $Action.ToLowerInvariant()
$BasePolicy = $BasePolicy.ToLowerInvariant()

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

if ($RepoDir -and (Test-Path -LiteralPath $RepoDir)) {
    $RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path
}
if ($WorktreePath -and (Test-Path -LiteralPath $WorktreePath)) {
    $WorktreePath = (Resolve-Path -LiteralPath $WorktreePath).Path
}

$payload = [ordered]@{
    repoDir          = $RepoDir
    worktreePath     = $WorktreePath
    batchId          = $BatchId
    subtaskId        = $SubtaskId
    baseRef          = $BaseRef
    basePolicy       = $BasePolicy
    baseHead         = $BaseHead
    expectedMainHead = $ExpectedMainHead
    allowHeadDrift   = [bool]$AllowHeadDrift
    dryRun           = [bool]$DryRun
    linkDirs         = @($LinkDirs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    keepBranch       = [bool]$KeepBranch
    force            = [bool]$Force
    worktreeRoot     = $WorktreeRoot
}

$node = Resolve-NodeLaunch
$wtScript = Join-Path $PSScriptRoot 'lib\worktree.mjs'
$json = $payload | ConvertTo-Json -Compress -Depth 6
$json | & $node $wtScript $Action
exit $LASTEXITCODE
