# Codex Loop Viewer

Antigravity 右侧辅助栏插件，用于在 Antigravity 内部实时、原样查看 `codex-loop` 派单中 **AGY ↔ Codex** 的每一轮双向交互内容，同时完整保留聊天中的 `codex://threads/<id>` 桌面直达链接。

## 核心能力

- **自动聚焦当前对话**：优先展示当前 AGY 对话触发的派单，也支持下拉切换「当前工作区」与「其他历史派单」。
- **实时流式刷新**：按文件变更指纹（ETag）与字节偏移增量读取 `*.events.jsonl` 与 `*.status.json`，**零额外对话 Token 消耗**。
- **双向原样展示（消息优先）**：默认直接展示 AGY 发出的任务书/打回原文、Codex 回复消息与结构化回执。连续的命令执行、工具调用、文件变更与思考摘要默认按组收起（也可在右上角 `⋯` 菜单开启「仅看消息（隐藏工具行）」），需要排查细节时随时展开，并支持点击改动文件直接在 AGY 侧栏打开，以及分页查看 **Raw 原文弹窗**（`Prompt` / `Events` / `Handoff` / `Status` / `Stderr` / `Rollout`）。
- **报错堆栈默认收起**：每轮底部的 **异常 / Stderr** 与事件流中的长报错默认收起并展示首行摘要，点击可按需展开/收起并在刷新时保留展开状态；默认清理展开正文中的 ANSI 颜色控制码（可在 `⋯` 菜单关闭以查看原始控制码）。
- **双端无缝接续**：顶部支持一键唤起 Codex 桌面端或复制 `codex://threads/<id>` 链接；在 Codex 桌面端继续聊产生的后续轮次，以及归档压缩后的 `.jsonl.zst` 原生记录，均可自动同步还原。
- **与 Skill 完全解耦**：不依赖修改 `codex-loop` Skill 目录或软链；禁用或卸载本插件后，原 `codex-loop` Skill 不受任何影响。

---

## 环境要求

- **Antigravity 2.0 桌面端**（支持插件 Sidecar 侧栏）
- 零第三方 npm 依赖（直接运行在 Antigravity 内置 Node 运行时中，无需执行 `npm install`）

---

## 安装步骤

### 1. 解压到 Antigravity 插件目录

将压缩包中的 **`codex-loop-viewer`** 文件夹完整解压放到用户级插件目录下：

- **Windows**：
  ```text
  C:\Users\<你的用户名>\.gemini\config\plugins\codex-loop-viewer
  ```
- **macOS / Linux**：
  ```text
  ~/.gemini/config/plugins/codex-loop-viewer
  ```

> **注意目录层级**：解压后确认 `plugin.json` 的路径是 `.../plugins/codex-loop-viewer/plugin.json`（不要多套一层 `codex-loop-viewer/codex-loop-viewer/`）。

### 2. 在 Antigravity 中启用插件

1. 打开 Antigravity 左侧 **Customizations → Installed**（或重启一次 Antigravity 让新 Sidecar 自动加载）。
2. 在插件列表中找到 **Codex Loop**（`codex-loop-viewer`），确认开关处于开启状态。
3. 如果首次安装后右侧栏 `+` 菜单尚未出现 **Codex Loop**，把插件开关 **关闭再重新打开一次**，或重启 Antigravity 即可。

### 3. 打开侧栏面板

- **方式一**：在任意对话的右侧辅助栏点击 **`+`**，选择 **Codex Loop**。
- **方式二**：在开启本插件且 Sidecar 运行时，使用 `codex-loop` 派单的首轮启动消息会附带一枚 **`Codex Loop`** 侧栏胶囊，点击即可展开/收起面板。

---

## 与 `codex-loop` Skill 配合说明

- **不升级旧版 `codex-loop` 也能直接用**：插件会自动扫描 `~/.gemini/antigravity/brain/*/scratch/` 与 `%TEMP%\codex-loop` 下已有的派单日志，并从 Codex 原生 `rollout-*.jsonl(.zst)` 回退还原历史任务书与对话。
- **配合最新版 `run-codex.ps1` 体验更佳**：最新版脚本额外提供每轮不可变 `<turn>.prompt.txt` 落盘、原子写 `status.json`、按对话 ID 精准关联的 200 条上限索引 `runs.json` 以及默认临时目录自动清理（14 天 / 50 条上限）。

---

## 更新与卸载

- **更新插件**：用新版本覆盖 `~/.gemini/config/plugins/codex-loop-viewer` 目录后，在 **Customizations → Installed** 里把 **Codex Loop** 关闭再打开一次即可热重载后端，无需重启 Antigravity。
- **禁用 / 卸载**：直接在 **Customizations → Installed** 关闭或卸载，或删除 `codex-loop-viewer` 文件夹即可。

---

## 常见问题

- **面板显示“暂无 codex-loop 派单记录”**：先通过 `codex-loop` 发起一次派单，或在顶栏下拉框切换到「当前工作区 / 其他历史派单」。
- **点击“Codex”按钮没有拉起桌面端**：检查本机是否已安装 Codex 桌面端并注册 `codex://` 协议；若唤起失败，插件会自动把 `codex://threads/<id>` 链接复制到剪贴板。
- **更新文件后请求报错（如 405）**：说明旧版 Sidecar 进程还在内存里运行，在插件管理页关闭再重新开启 **Codex Loop** 即可重载。
