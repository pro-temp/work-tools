# Context Lens

Antigravity 2.0 辅助侧栏。环形图显示当前会话用了多少上下文、距离请求压缩预算还有多少空间。面板可将已有的会话记录整理成中文 Markdown，供新会话接续工作。

## 查看上下文

在会话右侧辅助栏的 **＋** 菜单选择 **Context Lens**。面板通过 Antigravity 官方 `/preload.js` 获取会话 ID、宿主主题与工作区，并由宿主桥接为本地 API 请求附上鉴权 Token。

- 环中央显示已用 Token 与模型原生窗口。把鼠标移到弧段或分类行，或用 Tab 聚焦，即可看该类占用。点击可锁定，再点一次可取消。
- 「系统」和「扩展定制」下方直接列出有占用的子项，可查看系统提示词、工具、规则、技能等各自的 Token 数和窗口占比。
- 请求预算小于原生窗口时，环上的刻度和下方的预算条一起标出压缩阈值。达到预算的 75% 和 90% 时，进度条分别变为琥珀色和红色。
- **实时精确**使用最近一代的分类统计。首次生成前显示步骤估算，刚完成压缩时使用检查点摘要估算。检查点缓冲单列。
- 展开文件组可查看产物、知识、技能和自动加载配置。文件存在时可在 AGY 侧栏打开，也可复制路径。右上角 **⋯** 提供 CLI 文本报告与手动刷新。

## 生成交接文档

**复制交接**直接复制精简版。**交接文档**可预览精简版或完整版，查看字符数、约估 Token、涵盖轮次与文件数，并导出到 Downloads 或当前会话目录。

精简版保留首轮和最近三轮用户指令、最近三条实质回复、最近六条去重命令，以及任务清单和文件索引。完整版保留已记录的用户指令、实质回复和完整命令。文档末尾列出下一会话可以接续的任务。

消息优先取自 `brain/<会话 ID>/.system_generated/logs/transcript.jsonl`，缺少记录时读取会话数据库。产物索引包含该会话目录顶层的 Markdown 文件。文本从本地记录提取，文档的 Token 数按 UTF-8 字节数除以四向上取整。

## 运行与数据

打开带会话 ID 的面板时，官方预加载会执行一次本地 `get-conversation-metadata` 查询以解析 `projectId`。这次宿主初始化不访问远端，也不消耗 LLM Token。

插件后端使用 Antigravity 内置 Node 的 `node:sqlite` 只读打开数据库。可见侧栏每三秒读取一次本地报告，交接文档按需从本地记录生成。插件自身的后端、轮询与交接逻辑均为零外部请求、零 RPC、零子进程，无需 Python。模型窗口来自内置前缀表，未知模型使用会话记录中的请求预算。显式导出时才写入 Markdown 文件，遇到同名文件会追加序号。

仓库的挂载脚本会扫描 `agy-plugins/context-lens/`。插件不包含对话规则。可在 **Customizations → Installed** 管理插件开关。

## 来源与许可

上下文核算、protobuf 字段映射与 CLI 报告格式参考本地 `desktop-context` 的 `context_report.py`。以下为该实现的 MIT 许可。

```text
MIT License

Copyright (c) 2026 Dimitrios Ioannidis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

