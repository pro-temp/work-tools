<#
.SYNOPSIS
  Link work-tools skills, Antigravity (AGY) plugins, and global rules into local runtime directories.

.DESCRIPTION
  Uses this repository as the single source of truth and creates symbolic links in
  ~/.agents/ and ~/.gemini/config/. Existing real files or directories at target
  paths are backed up to ~/.work-tools-backups/<timestamp>/ before linking.
  Unmanaged skills/plugins already present on the machine are left untouched.

.EXAMPLE
  pwsh -File .\scripts\install.ps1 -WhatIf
  pwsh -File .\scripts\install.ps1
  pwsh -File .\scripts\install.ps1 -Status
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$Status,
  [string]$BackupRoot = (Join-Path $env:USERPROFILE '.work-tools-backups')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$homeDir = $env:USERPROFILE
$agentsDir = Join-Path $homeDir '.agents'
$agentsSkillsDir = Join-Path $agentsDir 'skills'
$geminiConfigDir = Join-Path $homeDir '.gemini\config'
$geminiSkillsDir = Join-Path $geminiConfigDir 'skills'
$geminiPluginsDir = Join-Path $geminiConfigDir 'plugins'
$sharedPluginDir = Join-Path $geminiPluginsDir 'shared-agent-skills'
$sharedPluginSkillsDir = Join-Path $sharedPluginDir 'skills'

# Skills in this repo that should also be bridged into AGY via shared-agent-skills
$sharedBridgeSkills = @(
  'bun-effect-drizzle-conventions',
  'business-frontend-ai-navigation',
  'confluence-flow',
  'frontend-web-platform-guidance',
  'instruction-audit',
  'jira-flow',
  'usage-query'
)

$mappings = [System.Collections.Generic.List[hashtable]]::new()

# 1. Skills (all repo skills -> ~/.agents/skills/<name>, except codex-loop -> ~/.gemini/config/skills/codex-loop)
Get-ChildItem (Join-Path $repoRoot 'skills') -Directory | Sort-Object Name | ForEach-Object {
  if ($_.Name -eq 'codex-loop') {
    $mappings.Add(@{
      Kind   = 'Directory'
      Source = $_.FullName
      Link   = Join-Path $geminiSkillsDir 'codex-loop'
      Label  = 'skill:codex-loop (gemini)'
    })
    $mappings.Add(@{
      Kind   = 'Directory'
      Source = Join-Path $geminiSkillsDir 'codex-loop'
      Link   = Join-Path $agentsSkillsDir 'codex-loop'
      Label  = 'skill:codex-loop (agents bridge)'
    })
  } else {
    $mappings.Add(@{
      Kind   = 'Directory'
      Source = $_.FullName
      Link   = Join-Path $agentsSkillsDir $_.Name
      Label  = "skill:$($_.Name)"
    })
  }
}

# 2. AGY plugins
Get-ChildItem (Join-Path $repoRoot 'agy-plugins') -Directory | Sort-Object Name | ForEach-Object {
  if ($_.Name -eq 'shared-agent-skills') {
    # Keep shared-agent-skills/ as a real directory so unmanaged local skill links stay intact
    $mappings.Add(@{
      Kind   = 'File'
      Source = Join-Path $_.FullName 'plugin.json'
      Link   = Join-Path $sharedPluginDir 'plugin.json'
      Label  = 'agy-plugin:shared-agent-skills/plugin.json'
    })
  } else {
    $mappings.Add(@{
      Kind   = 'Directory'
      Source = $_.FullName
      Link   = Join-Path $geminiPluginsDir $_.Name
      Label  = "agy-plugin:$($_.Name)"
    })
  }
}

# 3. Bridge selected skills into shared-agent-skills/skills/
foreach ($name in $sharedBridgeSkills) {
  $repoSkill = Join-Path $repoRoot "skills\$name"
  if (Test-Path $repoSkill) {
    $mappings.Add(@{
      Kind   = 'Directory'
      Source = Join-Path $agentsSkillsDir $name
      Link   = Join-Path $sharedPluginSkillsDir $name
      Label  = "shared-bridge:$name"
    })
  }
}

# 4. Global rules
$mappings.Add(@{
  Kind   = 'File'
  Source = Join-Path $repoRoot 'rules\agents\AGENTS.md'
  Link   = Join-Path $agentsDir 'AGENTS.md'
  Label  = 'rule:agents/AGENTS.md'
})
$mappings.Add(@{
  Kind   = 'File'
  Source = Join-Path $repoRoot 'rules\agents\ATTRIBUTION.md'
  Link   = Join-Path $agentsDir 'ATTRIBUTION.md'
  Label  = 'rule:agents/ATTRIBUTION.md'
})
$mappings.Add(@{
  Kind   = 'File'
  Source = Join-Path $repoRoot 'rules\antigravity\AGENTS.md'
  Link   = Join-Path $geminiConfigDir 'AGENTS.md'
  Label  = 'rule:antigravity/AGENTS.md'
})

# Secondary cross-tool rule links (only link if parent dir exists)
$geminiMdLink = Join-Path $geminiConfigDir 'GEMINI.md'
if (Test-Path $geminiConfigDir) {
  $mappings.Add(@{
    Kind   = 'File'
    Source = Join-Path $agentsDir 'AGENTS.md'
    Link   = $geminiMdLink
    Label  = 'rule:gemini/GEMINI.md -> ~/.agents/AGENTS.md'
  })
}
$codexDir = Join-Path $homeDir '.codex'
if (Test-Path $codexDir) {
  $mappings.Add(@{
    Kind   = 'File'
    Source = Join-Path $agentsDir 'AGENTS.md'
    Link   = Join-Path $codexDir 'AGENTS.md'
    Label  = 'rule:codex/AGENTS.md -> ~/.agents/AGENTS.md'
  })
}

function Normalize-PathString([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  return [System.IO.Path]::GetFullPath($p).TrimEnd('\').ToLowerInvariant()
}

function Get-LinkState([hashtable]$m) {
  if (-not (Test-Path -LiteralPath $m.Link)) {
    return @{ State = 'Missing'; CurrentTarget = '' }
  }
  $item = Get-Item -LiteralPath $m.Link -Force
  if ($item.LinkType) {
    $rawTarget = if ($item.Target -is [array]) { $item.Target[0] } else { [string]$item.Target }
    $resolvedTarget = if ([System.IO.Path]::IsPathRooted($rawTarget)) {
      $rawTarget
    } else {
      Join-Path (Split-Path -Parent $m.Link) $rawTarget
    }
    if ((Normalize-PathString $resolvedTarget) -eq (Normalize-PathString $m.Source)) {
      return @{ State = 'Linked'; CurrentTarget = $rawTarget }
    }
    return @{ State = 'WrongLink'; CurrentTarget = $rawTarget }
  }
  return @{ State = 'RealItem'; CurrentTarget = '' }
}

if ($Status) {
  foreach ($m in $mappings) {
    $st = Get-LinkState $m
    $detail = if ($st.CurrentTarget) { " -> $($st.CurrentTarget)" } else { '' }
    Write-Host ("[{0,-9}] {1,-44} {2}{3}" -f $st.State, $m.Label, $m.Link, $detail)
  }
  exit 0
}

$backupSessionDir = $null
$counts = @{ Linked = 0; Skipped = 0; BackedUp = 0; Failed = 0 }

foreach ($m in $mappings) {
  $st = Get-LinkState $m
  if ($st.State -eq 'Linked') {
    Write-Host "[OK]      $($m.Label)"
    $counts.Skipped++
    continue
  }

  $parent = Split-Path -Parent $m.Link
  if (-not (Test-Path -LiteralPath $parent)) {
    if ($PSCmdlet.ShouldProcess($parent, 'Create parent directory')) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
  }

  try {
    if ($st.State -eq 'WrongLink') {
      if ($PSCmdlet.ShouldProcess($m.Link, "Replace symlink (was -> $($st.CurrentTarget))")) {
        $item = Get-Item -LiteralPath $m.Link -Force
        if ($item.PSIsContainer) {
          [System.IO.Directory]::Delete($m.Link, $false)
        } else {
          [System.IO.File]::Delete($m.Link)
        }
      }
    } elseif ($st.State -eq 'RealItem') {
      if (-not $backupSessionDir) {
        $backupSessionDir = Join-Path $BackupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
      }
      $relFromHome = if ($m.Link.StartsWith($homeDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        $m.Link.Substring($homeDir.Length).TrimStart('\')
      } else {
        Split-Path -Leaf $m.Link
      }
      $backupDst = Join-Path $backupSessionDir $relFromHome
      if ($PSCmdlet.ShouldProcess($m.Link, "Backup to $backupDst and replace with symlink -> $($m.Source)")) {
        $backupParent = Split-Path -Parent $backupDst
        if (-not (Test-Path -LiteralPath $backupParent)) {
          New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
        }
        Move-Item -LiteralPath $m.Link -Destination $backupDst -Force
        $counts.BackedUp++
      }
    }

    if ($PSCmdlet.ShouldProcess($m.Link, "Create symlink -> $($m.Source)")) {
      New-Item -ItemType SymbolicLink -Path $m.Link -Target $m.Source | Out-Null
      Write-Host "[LINKED]  $($m.Label) -> $($m.Source)"
      $counts.Linked++
    }
  } catch {
    Write-Warning "[FAILED]  $($m.Label) ($($m.Link)): $($_.Exception.Message)"
    $counts.Failed++
  }
}

Write-Host ""
Write-Host ("Summary: linked={0}, already-ok={1}, backed-up={2}, failed={3}" -f $counts.Linked, $counts.Skipped, $counts.BackedUp, $counts.Failed)
if ($backupSessionDir -and (Test-Path -LiteralPath $backupSessionDir)) {
  Write-Host "Backups saved to: $backupSessionDir"
}
if ($counts.Failed -gt 0) {
  exit 1
}
