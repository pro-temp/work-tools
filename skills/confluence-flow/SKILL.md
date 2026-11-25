---
name: confluence-flow
description: "读取、检索和维护 Confluence 知识库页面。用于页面链接、空间、章节、Wiki/Storage、附件、页面树移动或回收站请求，包括 search Confluence、edit a section 和 restore a page。"
---

# Confluence 页面

以本 Skill 目录为基准运行 Node.js 20.19 或更高版本。命令入口为 `node scripts/confluence.mjs`，参数见 `node scripts/confluence.mjs --help`。从其他目录调用时，先解析入口和用户文件的路径。

## 查询

直接执行 `search`、`read`、`scan`、`children`、`attachments` 或 `download` 并整理真实结果。先用默认 Wiki 表示，找结构用 `read --format outline`，找关键字用 `--grep`。分页沿用原参数及返回的位置，核对版本。多页扫描标出读取失败的页面。需要无损查看宏、布局或合并单元格时，读取 `--format storage`。

## 发布与修改

读取目标、父页或空间，根据请求准备 Wiki 或 Storage 正文。局部编辑优先从 outline 选章节或区域，保留同页其他内容。使用同一组参数先做预览。创建、更新、上传、移动和恢复的意图明确、内容齐全且预览吻合时，可沿用本轮授权，加 `--apply` 执行。缺少信息、目标有歧义、整页大范围覆盖或批量改动时，展示预览并等用户补充或确认。更新带 `--expected-version`；遇到版本冲突，读新版本、重新对照，不直接重试。

## 移入回收站

每次都先运行 `delete --page ID` 预览，保留根页时加 `--keep-root`。向用户展示根页精确标题、受影响页面数和完整子页清单（包括 ID、层级与版本），说明根页是否保留。**等用户明确确认这次预览后**，原样带上范围、`--apply --confirm-title` 的精确标题，以及 `--expected-tree` 的 `treeHash`。树或版本改变时，重新展示并确认。部分完成时根据 `trashed` 和 `stoppedAt` 核对剩余页面。恢复使用 `restore --page ID` 预览，按需指定父页。

## 首次连接

用 `doctor` 检查身份、空间和默认根页。缺配置时，引导用户在自己的终端通过环境变量或 `auth set --secret-stdin` 提供凭证。只展示实际检查结果。配置、字节分页、Wiki 语法与局部更新示例见[操作参考](references/usage.md)。
