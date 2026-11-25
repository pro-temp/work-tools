---
name: jira-flow
description: "查询、创建和更新 Jira 工单，读取变更历史、迭代和附件。用于带 Jira 项目、工单键或 JQL 的工作请求，包括 search issues、transition issue 和 add comment。"
---

# Jira 工单

以本 Skill 目录为基准运行 Node.js 20.19 或更高版本。命令入口为 `node scripts/jira.mjs`，参数见 `node scripts/jira.mjs --help`。从其他目录调用时，先解析入口和用户文件的路径，避免切换目录后选错文件。

## 查询

直接执行读取命令，向用户给出任务键、结论和必要的依据。列表从 `search` 开始，默认省略正文。需要评论、关联或精确更新时间时用 `issue KEY`。问多张工单何时流转时，单次运行 `history KEY1 KEY2 --fields status`，指出失败项和 `complete: false` 的历史范围。需要保存附件时用 `download` 并给出本地位置。

## 写入

先读取目标上下文。创建前用 `create-context` 查项目的实际类型、必填字段和允许值。重名用户用 `users` 列候选，迭代用 `sprints` 匹配。流转前用 `transitions KEY` 查目标和必填字段。

用完整参数运行一次预览。创建、改字段、评论、流转或上传的意图明确、内容齐全且预览吻合时，可沿用本轮授权，加 `--apply` 执行。目标不唯一、必填信息缺失、批量改动或大范围覆盖时，展示具体差异并等用户补充或确认。更新和流转优先带预览或详情返回的精确 `--expected-updated`。版本变化后重新读取和预览。

长正文、评论和 JSON 字段优先用 UTF-8 文件。补写已有描述时，用 `issue KEY --full --format json` 的 `raw.fields.description` 保留原始正文格式（Wiki 或 HTML），追加后写入 `--body-file`。报告实际回执中的 key 和逐文件状态。若 `created: true` 伴随附件失败，核对该任务的附件清单，再用 `attach KEY` 补传缺失文件。创建请求中断且没有回执时，先查 Jira 核实。

## 首次连接

用 `doctor` 检查身份和默认项目。缺配置时，引导用户在自己的终端通过环境变量或 `auth set --secret-stdin` 提供凭证。只展示实际检查结果。配置示例、翻页和文件参数见[操作参考](references/usage.md)。
