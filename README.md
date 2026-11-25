# work-tools

个人自建的跨 Agent Skills、Antigravity（AGY）插件与全局规则集合。本仓库作为**唯一源头**，通过符号链接挂载到本机 `~/.agents/` 与 `~/.gemini/config/` 运行目录。

## 目录结构

```text
work-tools/
├── skills/                             # 自建跨 Agent Skills（9 个）
│   ├── bun-effect-drizzle-conventions/ # Bun / Effect / Drizzle 编码约定（从全局指令拆出）
│   ├── business-frontend-ai-navigation/# 业务前端仓库 AI 导航改造
│   ├── codex-loop/                     # Antigravity + Codex 双向协作闭环
│   ├── confluence-flow/                # Confluence 知识库读写与维护 CLI
│   ├── frontend-web-platform-guidance/ # 前端 Web 平台布局/弹层/性能/兼容指导（中文适配版）
│   ├── gpt-dragon-image/               # GPT 白龙娘角色绘图与验收
│   ├── instruction-audit/              # AGENTS.md / CLAUDE.md / SKILL.md 指令审计与精简
│   ├── jira-flow/                      # Jira 工单查询/创建/流转 CLI
│   └── usage-query/                    # 自然语言查询本地 ccusage Token 用量
├── agy-plugins/                        # 自建 Antigravity（AGY）插件（3 个）
│   ├── codex-loop-viewer/              # 右侧栏 Sidecar：实时原样查看 codex-loop 交互
│   ├── next-step-advisor/              # 回复末尾下一步建议 + /next 原生选项卡片
│   └── shared-agent-skills/            # 将 ~/.agents/skills 中精选技能桥接到 AGY
├── rules/                              # 自建全局规则（2 份）
│   ├── agents/                         # 跨 Agent 全局工程规则（AGENTS.md + ATTRIBUTION.md）
│   └── antigravity/                    # Antigravity 工作进度汇报规则（AGENTS.md）
└── scripts/
    └── install.ps1                     # Windows 一键创建/校验符号链接（原文件自动备份）
```

## 快速挂载（Windows）

```powershell
# 预览将创建的软链（不做实际修改）
pwsh -File .\scripts\install.ps1 -WhatIf

# 执行挂载（原位置如有真实文件/目录，自动备份至 ~/.work-tools-backups/<timestamp>/）
pwsh -File .\scripts\install.ps1

# 查看所有软链状态
pwsh -File .\scripts\install.ps1 -Status
```

- 仅管理本仓库包含的条目；本机已有的公司私有 Skill、官方市场插件与第三方插件不受影响。
- `agy-plugins/shared-agent-skills` 在本机保留为普通目录，脚本仅软链其 `plugin.json` 并在 `skills/` 下补齐精选技能软链，详见 [shared-agent-skills/README.md](agy-plugins/shared-agent-skills/README.md)。

## 本地映射对照

| 类型 | 仓库路径 | 本机运行目录 |
| --- | --- | --- |
| 通用 Skills（8 个） | `skills/<name>` | `~/.agents/skills/<name>` |
| `codex-loop` Skill | `skills/codex-loop` | `~/.gemini/config/skills/codex-loop`（`~/.agents/skills/codex-loop` 软链指向此处） |
| AGY 插件 | `agy-plugins/<name>` | `~/.gemini/config/plugins/<name>`（`shared-agent-skills` 仅软链 `plugin.json`） |
| 跨 Agent 全局规则 | `rules/agents/AGENTS.md`（及 `ATTRIBUTION.md`） | `~/.agents/AGENTS.md`（`GEMINI.md` / `.codex/AGENTS.md` 软链至此，Claude `CLAUDE.md` 引用至此） |
| AGY 进度汇报规则 | `rules/antigravity/AGENTS.md` | `~/.gemini/config/AGENTS.md` |

## 隐私与凭据说明

- `jira-flow` 与 `confluence-flow` 的连接配置与密钥保存在用户目录 `~/.config/{jira-flow,confluence-flow}/config.json` 或环境变量中，本仓库不包含任何真实凭据。
- 含公司私有包名或本机业务路径的 Skill 未纳入本仓库。
