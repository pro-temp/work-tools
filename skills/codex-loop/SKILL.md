---
name: codex-loop
description: >-
  手动触发的 Antigravity 与 Codex 双向协作闭环（支持派单实现、只读反向审查、双盲独立方案）。
  仅当用户明确要求调用 Codex 或 codex-loop（例如“用 codex 做”“派给 codex”“让 codex 审一下”
  “让 codex 独立出方案”）时启用；讨论、查看或修改本 Skill 本身，以及未要求调用 Codex 的常规请求，均不要激活。
---

# Antigravity + Codex 双向协作闭环

由协调端（主控，如 Antigravity / Gemini）负责需求理解、沟通、UI/文案把关与独立严审，由执行端（Codex / GPT）负责硬核代码实现、命令验证与只读反向把关，形成「主控治 GPT 过度防御与不粘锅，Codex 治主控粗心与漏细节」的双向互补。

下文中的 `<skill-dir>` 指本 Skill 所在目录（即当前 `SKILL.md` 所在路径，例如 `~/.gemini/config/skills/codex-loop` 或 `~/.agents/skills/codex-loop`）。

## 角色分流（两端共享本 Skill 时必看）

- **协调端（主控，如 Antigravity）**：负责拆单、调用 `<skill-dir>\scripts\run-codex.ps1` 派单、按 `TaskKind` 分流验收、核对真实 `git diff` 与精准打回。
- **执行端（Codex CLI / Desktop）**：**禁止调用 `run-codex.ps1` 递归派单**。收到派单或显式 `$codex-loop` 调用时，按任务类型（`implement` / `plan` / `review`）直接执行，遵守本文执行纪律（反过度防御、同类联查、吹哨防走歪、先做完无阻塞部分再提问）并交付结果；若由脚本启动，严格按 JSON Schema 返回回执。

## 三种协作模式与派活边界

三种模式均由协调端通过 [run-codex.ps1](./scripts/run-codex.ps1) 调用（传 `-TaskKind`），严禁手拼 `codex exec` 或使用 `--last`：

- **实现闭环（`-TaskKind implement`，默认）**：主控派单 → Codex 改代码并实跑验证 → 主控对照真实 `git diff` 严审打回（最多 2 轮）。
- **反向审查（`-TaskKind review`）**：主控改完代码或用户要求审现有改动时，派 Codex 在只读模式下审查真实 Diff，补齐严谨度。
- **双盲方案（`-TaskKind plan`）**：涉及公共接口、数据存储、跨模块架构取舍或复杂排障时，主控与 Codex 各自独立出方案，再对照代码实证合并。

> 注意：`-TaskKind plan|review` 保证**目标项目只读**，但脚本仍会在 `$RunDir` 写入运行状态/日志并登记桌面侧栏。若任务严格要求本机任何文件都不可写，请直接在已打开的独立会话返回文本。

**派活分工边界**（减少无谓沟通成本；用户明确指定执行者时以用户为准）：
- 几十行小改、修审查指出的零碎问题、需边看页面边调样式/交互和界面文案的改动，优先由主控直接完成。
- 接口稳定、边界清晰、可独立验证的成块模块（后端、算法、数据处理、性能优化、复杂 Bug 根因排查）优先派给 Codex；多步跨页 UI 流程可按需交 Codex 使用已授权的浏览器工具核查。
- 需求同时包含核心逻辑与前端 UI/文案时，可把接口与逻辑派给 Codex，前端视觉与文案留给主控（或在 Codex 交回后由主控把关界面文案）。

---

## 实现闭环流程（`-TaskKind implement`，默认）

### 1. 轻量收单与写任务书

- 确认工作目录、交付目标、已知约束和验收命令。**不要先自己通读整个仓库**再让 Codex 重读一遍。
- 任务书首行写一个能在侧栏认出这项工作的标题，例如 `# 修复导出报表的国际化占位符`。脚本会把首个非空行写为新会话的桌面名称。
- 将任务书写到临时 UTF-8 文件（如 `$RunDir\prompt.txt`）。Codex 看不到主对话上下文，内容精炼且一次写清：
  1. 目标与边界（写清最终**要解决什么问题 / Why**、接口契约、可改范围、验收标准、不要碰什么、受影响的同类入口，以及要跑的验证命令）。
  2. 执行纪律：
     - 遵守 `~/.codex/AGENTS.md` 中的工程规范，禁止无证据的防御判空/兜底/兼容分支。
     - 必须在回执的 `guards_and_fallbacks` 字段中如实自报每一条新增的判空、兜底、`try/catch`、锁、重试及可达证据。
     - **改全与同类联查**：新增同类能力、替换概念或修改规则时，先拿已有同类实现当参照，用 `rg` / `git grep` 查出全仓同类入口、配置、测试与说明一并改齐；改完再按**改动前的旧说法**反搜一遍，清理过时的注释、文档或旧限制文案。
     - **吹哨防走歪**：如果读完代码拿到确凿证据，证明本次要求的前提错误或按字面改会导致明显走歪（例如根因不在这里、会破坏已有契约/调用方、仓库已有现成实现不该重造），**不要闷头照做**，立刻返回 `status: "needs_input"`，写明代码证据与推荐方案；若只是顺手发现的非阻断方案隐患，按原任务做完但把带代码证据的提醒写入 `design_concerns`（没实证就留空 `[]`，禁止凑数免责）。
     - **先做完无阻塞部分再提问**：代码可推导或可逆的小决策自行拍板并写入 `assumptions`，不要反问；确实存在无法从代码确定的业务分歧或上述前提硬伤时，先把不依赖该决定的部分做完，再一次性返回 `status: "needs_input"`，写清代码事实、推荐选项与各选项后果。
     - **高危先问与常规豁免**：遇到不可逆或外部副作用操作（删数据/删库、停服、`git push --force`、清空外部目录、对外发消息或公开评论、装全局包、改密钥/权限/系统配置），禁止偷偷执行，先把无阻塞部分做完后返回 `status: "needs_permission"` 并写清精确命令与影响。**项目内代码读写、常规构建/测试/类型检查、只读代码检索均不算高危，直接执行。**
     - “未执行、待处理、不提交”等过程状态只写进回执单，不要写进仓库文档。

### 2. 按作业范围选模式并调用封装脚本

使用 `<skill-dir>\scripts\run-codex.ps1` 调用（默认采用每单私有 `codex app-server --listen stdio://` 引擎，保留 `-Engine exec` 兼容回退；跨进程硬限最大并发 2；挂载 Windows Job Object 并在中断时 `taskkill /T` 清理整棵进程树；实时写入 `*.events.jsonl` 与 `*.status.json`、按 `-TaskKind` 锁权、续接前校验 `rollout-*.jsonl` 存在性）：

```powershell
pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
  -WorkDir "<工作区绝对路径>" `
  -TaskKind implement `
  -PromptFile "<任务书路径>" `
  -RunDir "<本单的运行目录>" `
  -ReportStartup `
  -CaptureBaseline
```

**每轮派单都带上 `-ReportStartup`，在启动消息里附上实际执行本轮任务的可点击链接。** 首轮发「已派单」，返工发「第 N 轮返工已启动」。原会话续跑成功时再贴一次同一链接，换会话时贴新链接。启动信息写到标准错误，标准输出保留为最终 JSON。

1. 启动命令输出 `CODEX_DESKTOP_URL=<URI>`，或本轮 `running` 状态已有 `desktop_url` 时，立即发送 `[完整 URI](完整 URI)`，两处都换成返回的地址。任务很快结束时，从本轮 `finished` 摘要取链接。启动失败时按第 3 步处理。
2. 如果启动命令已转入后台，链接还没就绪，就用下面的命令**单独等链接**。两个参数取自本轮 `CODEX_STARTUP` 的 JSON，也可以从本轮状态文件读取。若工具先返回了后台命令 ID，短等该命令的首行输出或启动错误即可。

   ```powershell
   pwsh -NoProfile -File "<skill-dir>\scripts\wait-desktop-link.ps1" `
     -StatusFile "<status_file>" -RunnerPid <runner_pid>
   ```

   在当前轮等这条短命令返回 URI，随即主动发送本轮启动消息和链接。如果它也转入后台，用**等链接这条命令自己的 ID** 等待其完成。Codex 此时可继续执行。若本轮结束仍没有链接，读取原派单命令的错误并告知用户。

任务类型（`-TaskKind`）与权限模式（`-Mode`）：
- **`-TaskKind plan` / `-TaskKind review`**：脚本自动锁定 `-Mode readonly`，并在启动前拒绝冲突的写权限参数；续跑自动继承该只读约束。
- **`-TaskKind implement`（默认）**：
  - **纯项目内作业**（代码、文档、配置、构建、测试）：默认 `-Mode yolo`（避开 Windows `unelevated` 沙箱拦截项目内写/删文件；读写边界由任务书约束 + 事后真实 `git diff` 严审兜底）。
  - **涉及电脑环境、软件安装升级、系统或安全设置**：禁止 `yolo`，改传 `-Mode auto`（或由主控报批后代执行单条命令）。
  - **纯只读排查**：传 `-Mode readonly`。
  - **需要沙箱锁死工作区**：传 `-Mode workspace`（可配合 `-AddDir <目录>` 最小放开关联目录）。

其他可选参数（默认不传时，首轮与返工均直接沿用 `~/.codex/config.toml` 与桌面端当前选择）：
- `-Engine <app-server|exec>`（默认 `app-server`，支持轮中实时纠偏与打断；仅在协议不兼容应急时切 `-Engine exec`）
- `-MaxConcurrency <数字>`（默认 `2`，跨进程硬上限）
- `-BatchId <批次ID>` / `-SubtaskId <子单标识>`（并发派多单时关联批次与子单标签，续跑自动继承）
- `-WorktreePath <独立worktree绝对路径>`（同仓双写并发时指向隔离工作树，续跑自动继承）
- `-Model <模型名>`（仅在派单显式指定模型时传）
- `-ReasoningEffort <low|medium|high|xhigh|ultra|max>`（仅在派单显式指定思考档位时传）
- `-ServiceTier priority`（仅在需要单次强制覆盖 Fast 档位时传）
- `-RunDir <目录>`（复用同一目录保存首轮基线、各轮 `*.status.json`、实时 `*.events.jsonl` 与回执；复用目录再次传 `-CaptureBaseline` 时不会覆盖已有首轮基线）

新派单默认插到 Codex 桌面端「Codex 派单」第一条，续跑沿用已登记会话的位置。`sidebar_registered` 为 `true` 表示分区登记已处理。点开会话时桌面端可能自动续接，两轮之间点开可能占用下一轮返工需要的写入权。只看进度时读本轮 `*.events.jsonl` 或在右侧栏查看。用户要接手时，停止自动返工并等当前派单退出，再从分区或直达链接继续聊（若绑定了 `worktree`，接手期间保留该目录）。

发出链接后，**立即结束本轮工具调用以保持主聊天可接收用户输入**，等待后台派单完成通知再验收。

### 2.5 运行中实时纠偏与打断（`steer-codex.ps1`）

当派单仍在后台运行、用户发消息指出任务跑偏或要求停止时，**不要傻等当前轮结束再 `resume`**，也不要直接强杀进程；主控应立即通过 `<skill-dir>\scripts\steer-codex.ps1` 向持有该轮的 runner 投递控制指令：

- **轮中纠偏转向（默认 `-Action steer`）**：用户说“跑偏了、别改 A 改 B”“补充要求 X”时，直接注入当前活动轮（底层调用 `turn/steer` + `clientUserMessageId` 幂等对账），保住已有上下文与结构化回执：
  ```powershell
  pwsh -NoProfile -File "<skill-dir>\scripts\steer-codex.ps1" `
    -RunDir "<本单运行目录>" `
    -Action steer `
    -Message "<精准纠偏指令>"
  ```
- **立即硬中止（`-Action interrupt`）**：用户明确喊停（“停”“别做了”）时发送 `turn/interrupt`；若用户要求“停下来改做 Y”，可附带 `-FollowUp "<新指令>"` 让同进程在确认 `interrupted` 终态后原地开启替代轮（或先确认停止、核查已有改动后再另起新轮）：
  ```powershell
  pwsh -NoProfile -File "<skill-dir>\scripts\steer-codex.ps1" `
    -RunDir "<本单运行目录>" `
    -Action interrupt `
    [-FollowUp "<停后替代指令>"]
  ```
- **目标单路由（并发 2 单时）**：仅有一单在跑时直接投递；有两单在跑时，按用户点名（子单标识/模块/主题）精准路由，仅在确实无法判断目标单时用 1 句话请用户指明再发。
- **回执状态与兜底**：
  - `applied_in_turn` → 向用户回报「纠偏已进入本轮」并继续等待原派单完成；
  - `accepted` / `queued_until_turn_start` → 回报「纠偏已接收，等待进入本轮」；
  - `already_finished` / `turn_not_active` → 说明原轮已收尾，待拿到终态后直接用 `-SessionId` 常规 `resume` 补发；
  - `not_controllable`（旧 `-Engine exec`）→ 告知旧引擎不支持轮中纠偏，征得同意后中止或等结束后 `resume`。

### 2.6 受控并发派多单（最大并发 2）与同仓自动 `worktree` 双写隔离

当一个大任务可拆出**互相独立、无前后依赖**的子任务时，主控可同时派发最多 **2 单** Codex 并行执行（脚本层通过跨进程槽位表硬限上限为 `2`，满槽时第 3 单直接返回 `error_kind: "slots_full"` 与当前活跃摘要，由主控排入待派列表，任一单完成后立刻补位）。

**拆单准入条件（必须同时满足）**：
1. 任务规模足够大，各自有清晰的独立交付物与独立验证命令；
2. 子任务 B 的输入不依赖子任务 A 尚未写完的代码、公共接口或 Schema；
3. 两单不共改同一锁文件、生成物或争抢同一本地端口/测试数据库（公共集成验证留待合并后统一跑）。

**执行与隔离流程**：
1. **只读任务（`plan`/`review`）或不同仓库目录**：直接为每单分配独立 `$RunDir`、传入同一 `-BatchId` 与不同 `-SubtaskId`（如 `A`/`B`），同轮并行启动 2 单并一次性给出两条桌面链接与分工。
2. **同仓双写（2 个 `implement` 同改一个 Git 仓库）**：**必须使用独立 `git worktree` 物理隔离**，通过 `<skill-dir>\scripts\worktree-codex.ps1` 管理完整生命周期：
   - **准备隔离工作树**：
     ```powershell
     pwsh -NoProfile -File "<skill-dir>\scripts\worktree-codex.ps1" `
       -Action prepare -RepoDir "<主仓路径>" -BatchId "<批次ID>" -SubtaskId "A"
     ```
     - 若主仓存在未提交改动，默认 `-BasePolicy clean` 会返回 `dirty_repo_for_worktree` 与脏文件清单。主控须核对子任务是否依赖这些未提交改动：**依赖则退回串行**；确与子任务无关时再显式传 `-BasePolicy head` 从 `HEAD` 建干净 worktree（若项目需复用未跟踪的依赖目录，可显式传 `-LinkDirs node_modules`；注意 Windows 下 `-LinkDirs` 是**共享可写**目录联接，仅在确认子单不会修改依赖目录或写入 `.cache` 时启用，否则在 worktree 内独立安装/使用独立缓存）。
   - **隔离派单与独立严审**：将 `prepare` 返回的 `worktree_path` 传给 `run-codex.ps1 -WorkDir "<主仓路径>" -WorktreePath "<worktree_path>" -BatchId "<批次ID>" -SubtaskId "A" -CaptureBaseline -ReportStartup`。任一单先完成即立刻用 `worktree-codex.ps1 -Action inspect -WorktreePath "<path>"` 核对隔离 Diff 与验证结果；需要返工时在**原会话 + 原 worktree** 续跑（脚本自动继承 `worktree_path`）。
   - **顺序预检集成与清理**：两单都通过严审后，按顺序对每单执行：
     ```powershell
     # 先无副作用预检（默认按 prepare 时的 main_head_at_create 校验主仓 HEAD 漂移、脏文件重叠与补丁冲突）
     pwsh -NoProfile -File "<skill-dir>\scripts\worktree-codex.ps1" `
       -Action integrate -RepoDir "<主仓路径>" -WorktreePath "<path>" -DryRun
     # 预检通过后正式应用到主工作区（不自动 git commit；如需显式指定预期主仓 HEAD，可传 -ExpectedMainHead "<main_head_at_create>"）
     pwsh -NoProfile -File "<skill-dir>\scripts\worktree-codex.ps1" `
       -Action integrate -RepoDir "<主仓路径>" -WorktreePath "<path>"
     ```
     - 遇 `dirty_overlap` / `patch_conflict` / `head_drifted` 时主仓零改动，由主控排查解决后再集成。
     - 全部集成完成并跑通**主仓联合构建/测试**后，执行清理：
       ```powershell
       pwsh -NoProfile -File "<skill-dir>\scripts\worktree-codex.ps1" `
         -Action cleanup -RepoDir "<主仓路径>" -WorktreePath "<path>" -Force
       ```
     - 若某单移交用户在桌面端接手，**禁止清理**其 worktree（脚本也会拒绝清理仍占槽的 worktree）。

### 3. 核对执行结果与异常/三态分流

脚本结束会输出 JSON 摘要。顶层的 `state`、`task_kind`、`session_id`、`effective`、`error_kind` 和 `handoff` 用于验收，`desktop_url`、`sidebar_registered`、`sidebar_title` 和 `sidebar_error` 分别记录直达链接、分区登记结果、登记时确认的会话名称和桌面登记错误。先核对 `effective` 中生效的模型、思考档位、Fast 档位和权限，仍按 `state` 判断派单结果。

- **运行时故障与预检失败处理**：
  - `error_kind == "slots_full"`：当前已有 2 个在跑派单（`active_slots` 列出在跑摘要），将其记为主控待派项，待任一在跑单结束后立刻补位启动，不要强行覆盖上限。
  - `error_kind == "duplicate_run_dir"`：同一 `$RunDir` 已有在跑 worker，检查是否为误重复派单或为新并发子单分配独立 `$RunDir`。
  - `error_kind == "active_writer"` 表示会话正被另一端占用。用户已要求桌面接手时，发回原会话链接并结束自动返工。仍由主控负责时，**新开会话**交接已有进度和结论，沿用同一 `$RunDir` 的首轮基线。按第 2 步从新启动命令取得链接，随返工消息发给用户。
  - `error_kind == "capacity"`（服务端临时满载）：等待 1–2 分钟后用**原 `session_id` 续接重试**，不擅自换模型。
  - `error_kind == "invalid_session"`：检查 `session_id` 是否拼错，核对后再续接。
  - `error_kind == "invalid_arguments"`：修正 `-TaskKind` 与 `-Mode` 的冲突后重派。
  - `error_kind == "unknown_resume_mode"`：跨运行目录续跑无法还原原权限时，显式传入已确认的 `-Mode` 再续跑（脚本不会静默落回 `yolo`）。
  - `error_kind == "invalid_handoff"`：回执状态与字段矛盾（如 `needs_input` 但 `questions` 为空），查看 `errors` 与 `handoff` 后用原 `session_id` 要求 Codex 补齐对应字段。
- **`handoff.status == "needs_input"`（Codex 提疑问）**：
  - 先做防“不粘锅”筛查：若问题能从代码推导、属于可逆小选择或用户先前已表态，**不要打扰用户**，由主控直接拍板并写清决策，用 `-SessionId <session_id>` 立即续跑。
  - 若确实是业务歧义、不可逆取舍或缺少外部凭据/信息：把问题精简成带推荐选项的直白问题向用户确认；用户回复后，用同一 `session_id` 与同一 `run_dir` 续跑，保留完整上下文。
- **`handoff.status == "needs_permission"` 或命令被权限策略拦截**：
  - 向用户展示需要执行的精确命令/路径、目的与可逆性，等待用户明确批准。
  - 获批后按最小权限推进：优先由主控代执行单条具体命令并将输出喂回 `-SessionId <id>`；若需 Codex 在额外目录作业，用 `-AddDir` 或切合适 `-Mode` 续跑。
- **`handoff.status == "done"`（按 `task_kind` 分流验收）**：
  - `task_kind == "implement"` → 进入第 4 步「主控独立严审与精准打回」。
  - `task_kind == "review"` → 进入「反向审查模式」第 3 步过滤收敛。
  - `task_kind == "plan"` → 进入「双盲方案模式」第 2 步实证合并。

### 4. 主控独立严审与精准打回

读取审核细则 [review-rubric.md](./references/review-rubric.md)，严格按以下顺序核验：

1. **看真实改动**：核对 `git rev-parse HEAD`、`git status`、`git diff` 与 `git diff --cached`（对照 `$RunDir\baseline.head.txt`、`baseline.status.txt`、`baseline.diff.patch`、`baseline.cached.patch` 扣除既有未提交改动）及新增未跟踪文件。
2. **核验实测结果**：确认 `handoff.verification` 中的命令已真实执行且通过；若遗漏关键检查或结果可疑，直接打回补跑或由主控补跑复核。
3. **扫两大红线、同类改全与设计吹哨**：逐项筛查「过度防御（`[DELETE_OVERDEFENSE]`）」与「不粘锅/半成品/改不全（`[MUST_FIX]`）」，核对 Diff 中新增防御代码与 `guards_and_fallbacks` 的证据是否吻合，同时审阅 `design_concerns`（真有代码证据的方案隐患及时处理或转告用户，凑数的假想风险直接滤掉）。发现一处同类漏改时，打回清单明确要求全仓扫齐同类；涉及实测 Bug 或反复踩坑的契约错，且仓库已有类型/测试体系时，顺手要求补一条针对性守卫拦截。纯风格建议不单独触发返工。
4. **原会话精准打回**：
   - 续跑不传 `-TaskKind` / `-Mode` / `-AddDir` 以及首轮显式指定过的 `-Model` / `-ReasoningEffort` / `-ServiceTier` 时，脚本自动继承该会话上一轮设置；若首轮本身未覆盖模型和 Effort，续跑也继续沿用 Codex 全局配置。
   - 将带 `文件:行号 + 原因 + 目标改法` 的返工单写入 `$RunDir\rework-N.txt`，原会话续跑：
     ```powershell
     pwsh -NoProfile -File "<skill-dir>\scripts\run-codex.ps1" `
       -WorkDir "<工作区绝对路径>" `
       -SessionId "<session_id>" `
       -RunDir "<同一 run_dir>" `
       -PromptFile "<返工单路径>" `
       -ReportStartup
     ```
5. **循环上限与熔断**：
   - 默认最多打回 **2 轮**（共最多 3 次 Codex 调用）。第 2 轮集中复查已报问题与修复引入的回归。
   - 第 2 轮返工后若仅剩零碎尾项（如删几行多余 `?.` 或死代码），由主控**直接修改并验证收口**，不再重拉 Codex。
   - 若根因仍未解决或越改越乱，立即止损停止循环，向用户呈现已尝试步骤、卡点证据与可选方案。

### 5. 终验与干净交付

确认最终 Diff 干净、验收命令通过后，由主控直接向用户交付：说明改了什么、跑了哪些验证及结果、有哪些值得注意的自主假设；**禁止复读 Codex 的免责套话**。若本次改动包含面向用户的界面文案或状态标签，交付前顺手检查精简（状态标签 2–4 字短促直白，去掉解释性废话和实现细节）。

脚本摘要顶层有 `desktop_url` 时，交付消息附上「在 Codex 中继续聊」，用完整 URI 作为链接文字，方便点击或复制。

---

## 反向审查模式（`-TaskKind review`）

当主控自己完成修改后需要独立把关，或用户明确要求让 Codex 审查代码/Diff 时启用。

1. **只读派单与档位策略**（同样遵守 `-ReportStartup` 立即发送桌面直达链接）：
   - 任务书首行写 `# 审查：<主题>`；传 `-TaskKind review` 调用 `<skill-dir>\scripts\run-codex.ps1`（自动锁死 `-Mode readonly`，不需要 `-CaptureBaseline`）。
   - **档位参考**（以用户显式指定优先；建议结合所在项目实测校准，不硬编码死在脚本里）：
     - 日常改动：传 `-ReasoningEffort high` 控耗时与噪声；若本机 Codex 支持轻量审查模型（如 `gpt-6.2-sol`），可先试传 `-Model gpt-6.2-sol -ReasoningEffort high`。
     - 高风险改动（权限/登录、资金/库存/核心写入、对外发消息、跨模块公共契约）：沿用强模型（如默认 `gpt-6.2-astra`）与 `xhigh`/`max`。
2. **审查任务书要求**：
   - 写清本次改动目标、业务约束、检查结果与审查范围（例如当前 `git diff` + `git diff --cached` + 未跟踪文件，或指定提交/文件）。
   - 要求 Codex 将发现按两级写入回执的 `design_concerns`（每条 `issue` 以 `[BLOCKING]` 或 `[ADVISORY]` 开头，`evidence` 写明 `文件:行号`、**可达输入或操作顺序**与违背的契约/验收条件，`suggestion` 写具体改法与复验办法；无发现留空 `[]`）：
     - `[BLOCKING]`：仅限会导致算错数据、丢数据、越权、崩溃、把失败伪装成空结果、破坏既有契约、同类漏改或验证失效，且说得出可达触发路径的问题。
     - `[ADVISORY]`：其余风格偏好、微优化或需多重巧合才发生的极端假设，只记不拦。
   - `summary` 先给明确结论（`通过` 或 `需修改`，附阻断项与建议项数量）；`changed_files` 与 `guards_and_fallbacks` 留空 `[]`；跑过的只读校验命令写入 `verification`。
3. **过滤收敛与轮次上限**：
   - 主控收到 `done` 后逐条对照真实代码核验：只修有实证的 `[BLOCKING]` 项（及顺手认可的 `[ADVISORY]` 项），**无法复现或上游契约已保证的条目直接过滤，不要为了迁就 Codex 在自己代码里加多余防御代码**。
   - 修复后如需复审，用同一 `-SessionId` 和 `-RunDir` 原会话续跑；**最多审 2 轮**。第 2 轮后仍有争议的，由主控整理代码证据与取舍交用户拍板。

---

## 双盲方案模式（`-TaskKind plan`）

用户点名双盲，或任务涉及公共接口、数据存储、跨模块架构取舍与复杂排障时启用（小需求直接执行，不走双盲）。

1. **严格隔离首稿（防锚定）**：
   - 任务书首行写 `# 方案：<主题>`，新开会话传 `-TaskKind plan` + `-ReportStartup` 调用（自动锁死 `-Mode readonly`）。
   - 任务书**只放相同的用户原话、必要背景、代码基线和验收目标**，**禁止附带主控自己的草稿、判断或倾向**。
   - 要求 Codex 基于真实代码独立给出推荐方案、关键证据、主要代价与验证办法（写入 `summary`），推导前提写入 `assumptions`，带 `文件:行号` 证据的契约风险或替代方案写入 `design_concerns`，仅靠代码定不了的业务分歧写入 `questions`；`changed_files` 与 `guards_and_fallbacks` 留空 `[]`。
2. **独立定稿与实证合并**：
   - 主控必须在查看 Codex 的事件流和回执前定下自己的独立初稿。
   - 两稿齐后，**以真实代码与运行事实为准**逐条合并呈现给用户拍板，按「主张 / 来源 / 采纳或舍弃 / 代码证据与理由」清晰标出：**双方一致项、采纳 Codex 的点、保留主控的点、未采纳项及依据、需用户拍板的分歧**。
   - 仅对**会改变方案选择**的分歧做一次定向复核；拍板落地时另开 `-TaskKind implement` 执行会话（或由主控直接实施）。

---

## 跨端单源同步说明（供开源与本地部署参考）

- **单源维护**：将本目录放在主控技能路径（如 `~/.gemini/config/skills/codex-loop`），再在 Codex 共享技能目录建目录软链接（如 `~/.agents/skills/codex-loop -> <skill-dir>`），两端共用同一份文档、Schema 与脚本，避免多份副本漂移。
- **显式调用保护**：[agents/openai.yaml](./agents/openai.yaml) 已配置 `policy.allow_implicit_invocation: false`，防止 Codex 在常规会话中自动激活本 Skill；共享工程规范统一维护在 `~/.agents/AGENTS.md`（各端软链引用即可）。
