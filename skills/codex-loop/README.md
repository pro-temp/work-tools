# codex-loop

面向 **Antigravity（Gemini）+ Codex（GPT）** 组合的本地双向协作 Skill（支持 Windows + PowerShell 7）。

在没有 Claude 的场景下，它把两端的能力做互补分工：
- **主控端（Antigravity / Gemini）管住 Codex（GPT）**：通过结构化回执强制自报防御代码、对照真实 `git diff` 严审并原会话打回，专治 GPT 的过度防御、不粘锅与免责套话。
- **Codex（GPT）帮主控端兜底严谨度**：通过只读反向审查（`-TaskKind review`）和双盲独立方案（`-TaskKind plan`），补齐 Gemini 容易粗心、漏改同类或误判代码契约的短板。

---

## 三种协作模式

| 模式 | `-TaskKind` | 目标项目权限 | 适用场景 | 验收方式 |
| :--- | :--- | :--- | :--- | :--- |
| **实现闭环（默认）** | `implement` | 默认 `yolo`（可按需切 `auto`/`workspace`/`readonly`） | 接口清晰、成块的后端、算法、数据处理、复杂 Bug 根因排查 | 主控核对真实 `git diff`（扣除首轮基线）与实测命令，按红线精准打回，最多 2 轮 |
| **反向审查** | `review` | 脚本硬锁 `readonly` | 主控自己改完代码后独立把关，或审查现有改动 | 按 `[BLOCKING]` / `[ADVISORY]` 两级与可达触发路径过滤，最多 2 轮 |
| **双盲方案** | `plan` | 脚本硬锁 `readonly` | 大架构选型、公共接口变更、跨模块重构、复杂排障 | 两端仅凭同一份中性任务书各自定稿，最后对照真实代码合并并标清分歧 |

---

## 环境要求

- **操作系统**：Windows（脚本使用 `taskkill /T` 清理进程树，并集成 Codex Windows Desktop 侧栏登记）
- **Shell**：PowerShell 7+（`pwsh`，脚本均声明 `#Requires -Version 7`）
- **Codex CLI**：已安装并登录 `@openai/codex`（`PATH` 中存在 `codex` 或 `codex.exe`）
- **主控端**：Antigravity 或其他支持 `SKILL.md` 的 Agent 客户端

---

## 安装与双端单源同步

### 1. 安装到主控端技能目录

将本仓库克隆或复制到你的主控端技能目录，例如 Antigravity：

```powershell
git clone <你的仓库地址> "$HOME\.gemini\config\skills\codex-loop"
```

### 2. 同步到 Codex 侧（单源软链，推荐）

Codex CLI / Desktop 会从 `~/.agents/skills` 加载用户级技能。建议**不要复制多份副本**，而是建一个目录软链接指向主控端目录：

```powershell
$src = "$HOME\.gemini\config\skills\codex-loop"
$dst = "$HOME\.agents\skills\codex-loop"

New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
try {
    New-Item -ItemType SymbolicLink -Path $dst -Target $src
} catch {
    # 未开启 Windows 开发者模式且无管理员权限时，可用 Junction 替代
    New-Item -ItemType Junction -Path $dst -Target $src
}
```

**为什么双端共享同一份目录不会互相干扰？**
- [SKILL.md](./SKILL.md) 顶部明确划分了「协调端（主控）」与「执行端（Codex）」职责，执行端禁止调用 `run-codex.ps1` 递归派单。
- [agents/openai.yaml](./agents/openai.yaml) 已配置 `policy.allow_implicit_invocation: false`，Codex 在日常会话中不会误激活本 Skill，仅在显式调用 `$codex-loop` 时加载。
- 若两端共用全局工程规范，推荐统一维护一份 `~/.agents/AGENTS.md`，再将 `~/.codex/AGENTS.md` 与 `~/.gemini/config/GEMINI.md` 软链到该文件。

---

## 使用方式

### 在主控端聊天中触发（手动触发）

本 Skill 设计为**仅在明确提及 Codex / `codex-loop` 时启用**，不会拦截常规对话：

- **派单实现**：`用 codex-loop 修复这个导出接口的并发覆盖问题`
- **反向审查**：`让 codex 审一下我刚才改的 diff`
- **双盲方案**：`这个跨模块改造先和 codex 跑一遍双盲方案再动手`

### 封装脚本直接调用示例

脚本会自动定位所在目录的 Schema，不依赖硬编码路径（下文 `<skill-dir>` 为本目录路径）：

```powershell
# 1. 实现闭环（首轮自动拍 Git 基线，并输出桌面直达链接事件）
pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
  -WorkDir "<工作区绝对路径>" `
  -TaskKind implement `
  -PromptFile "<任务书路径>" `
  -RunDir "<运行目录>" `
  -ReportStartup `
  -CaptureBaseline

# 2. 反向审查（自动锁死 readonly，日常审查可降思考档或试用轻量模型）
pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
  -WorkDir "<工作区绝对路径>" `
  -TaskKind review `
  -ReasoningEffort high `
  -PromptFile "<审查任务书路径>" `
  -RunDir "<运行目录>" `
  -ReportStartup

# 3. 双盲独立方案（自动锁死 readonly）
pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
  -WorkDir "<工作区绝对路径>" `
  -TaskKind plan `
  -PromptFile "<中性任务书路径>" `
  -RunDir "<运行目录>" `
  -ReportStartup

# 4. 原会话续跑（自动继承上一轮的 TaskKind、Mode、Model、ReasoningEffort 等参数）
pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
  -WorkDir "<工作区绝对路径>" `
  -SessionId "<session_id>" `
  -RunDir "<同一运行目录>" `
  -PromptFile "<返工或复审指令路径>" `
  -ReportStartup
```

---

## 核心设计

- **强结构化回执**：通过 [references/codex-handoff.schema.json](./references/codex-handoff.schema.json) 约束 11 个必填字段，强制自报每一条新增防御逻辑及可达证据（`guards_and_fallbacks`）、实跑命令及退出码（`verification`）、代码证据隐患（`design_concerns`），并由脚本校验三态载荷一致性（防止 `needs_input` 空问题或只读任务报告改文件）。
- **权限硬锁与续跑防提权**：`-TaskKind plan|review` 启动前拒绝任何写权限参数；跨 `$RunDir` 续跑若无法从本地状态或 `rollout` 还原原权限，直接报 `unknown_resume_mode` 退出，绝不静默落回 `--yolo`。
- **脏工作区首轮基线保护**：`-CaptureBaseline` 在首次运行时记录 `HEAD`、`status`、`diff` 与 `diff --cached`，复用 `$RunDir` 开新会话（如遇 `active_writer`）时自动保留首轮基线不覆盖。
- **实时可观测与桌面直达**：无缓冲写入 `*.events.jsonl` 与 `*.status.json`，支持通过 [scripts/wait-desktop-link.ps1](./scripts/wait-desktop-link.ps1) 快速拿到 `codex://threads/<id>` 链接，并自动将新派单登记到 Codex Desktop 的「Codex 派单」分区。
- **防过度审查与防过度防御闭环**：严审细则见 [references/review-rubric.md](./references/review-rubric.md)，既用「同类联查 + 棘轮拦截」治改不全与复发坑，也要求主控在反向审查时过滤掉无可达路径的假想防御建议。

---

## 目录结构

```text
codex-loop/
├── SKILL.md                             # 主控与执行端协作流程、角色分流与三种模式说明
├── README.md                            # 开源安装、同步与使用指南
├── agents/
│   └── openai.yaml                      # Codex 侧技能元信息（关闭隐式自动触发）
├── references/
│   ├── codex-handoff.schema.json        # Codex 结构化回执 JSON Schema
│   └── review-rubric.md                 # 严审红线、返工分级、反向审查过滤与打回模板
└── scripts/
    ├── run-codex.ps1                    # 核心封装脚本（派单、续跑、基线、校验、清理）
    ├── wait-desktop-link.ps1            # 后台派单时短等桌面直达链接
    └── add-sidebar-thread.ps1           # 通过 Codex App Server 设置标题并登记侧栏分区
```

---

## 注意事项

- **为什么实现模式默认 `-Mode yolo`**：Windows 下 Codex 的 `unelevated` 沙箱经常拦截项目内正常写/删文件，因此纯项目内作业默认使用 `yolo`，改由任务书边界 + 事后真实 `git diff` 严审兜底；涉及系统环境、全局安装或安全设置时请显式传 `-Mode auto` 或由主控报批代执行。
- **只读模式的落盘边界**：`-TaskKind plan|review` 保证不对目标工作区写文件，但脚本仍会在 `$RunDir` 写入状态/事件日志并登记桌面侧栏。若场景严格要求本机零写入，直接在已打开的独立会话中输出文本即可。
- **模型与思考档位**：脚本默认沿用 `~/.codex/config.toml` 配置，不硬编码单一模型。日常审查可先尝试降思考档（`-ReasoningEffort high`）或配合轻量审查模型（如 `gpt-6.2-sol`），再结合自己仓库的实测检出率与耗时校准。
