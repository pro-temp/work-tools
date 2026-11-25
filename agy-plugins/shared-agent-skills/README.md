# shared-agent-skills

Antigravity 本地桥接插件，将 `~/.agents/skills/` 中精选的跨工具 Skills 通过目录符号链接暴露给 Antigravity。

仓库内仅保留 `plugin.json`，不提交指向本机绝对路径的符号链接。部署到 `~/.gemini/config/plugins/shared-agent-skills/` 后，在 `skills/` 下为需要启用的 Skill 创建目录符号链接即可。

## 推荐链接清单

来自本仓库 `skills/`（8 个，不含直接放在 `~/.gemini/config/skills/` 的 `codex-loop` 和按需使用的 3 个生图 Skill）：

- `bun-effect-drizzle-conventions`
- `business-frontend-ai-navigation`
- `confluence-flow`
- `frontend-web-platform-guidance`
- `instruction-audit`
- `jira-flow`
- `usage-query`
- `weekly-monthly-report-summary`

其余公司私有/本机专用或第三方技能（未收录在本仓库）可按需在本机额外链接。

## Windows 创建软链示例（PowerShell）

```powershell
$pluginSkills = "$env:USERPROFILE\.gemini\config\plugins\shared-agent-skills\skills"
New-Item -ItemType Directory -Force -Path $pluginSkills | Out-Null

$names = @(
  'bun-effect-drizzle-conventions',
  'business-frontend-ai-navigation',
  'confluence-flow',
  'frontend-web-platform-guidance',
  'instruction-audit',
  'jira-flow',
  'usage-query',
  'weekly-monthly-report-summary'
)

foreach ($name in $names) {
  $link = Join-Path $pluginSkills $name
  $target = Join-Path "$env:USERPROFILE\.agents\skills" $name
  if (-not (Test-Path $link) -and (Test-Path $target)) {
    New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
  }
}
```
