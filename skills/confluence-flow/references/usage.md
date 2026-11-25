# Confluence 操作参考

下列命令均接在 `node scripts/confluence.mjs` 之后。`命令 --help` 显示完整参数。结果在 stdout，失败为 stderr JSON 和退出码 1，部分完成为 stdout JSON 和退出码 2。

## 连接

使用 `~/.config/confluence-flow/config.json` 或 `CONFLUENCE_FLOW_CONFIG`。baseUrl 包含产品上下文路径，例如 Cloud 的 `https://example.atlassian.net/wiki` 或自建站点的 `https://docs.example.org/confluence`。

```json
{"defaultProfile":"team","profiles":{"team":{"baseUrl":"https://example.atlassian.net/wiki","authType":"basic","email":"alice@example.org","space":"ENG","rootPageId":"123"}}}
```

用 `CONFLUENCE_TOKEN` 或 `CONFLUENCE_PASSWORD` 提供密钥。也可在用户终端由密码管理器管道输入 `auth set --secret-stdin`。Unix 上保存的用户配置权限为 0600。不要将密钥发到聊天或写入 Skill 文件。

```text
auth set --profile team --base-url https://example.atlassian.net/wiki --auth-type basic --email alice@example.org --space ENG --make-default
config show --profile team
doctor --profile team
```

选择顺序为 `--profile`、`CONFLUENCE_FLOW_PROFILE`、`defaultProfile`。命令参数优先于环境变量，环境变量优先于 profile。支持 `CONFLUENCE_BASE_URL`、`CONFLUENCE_AUTH_TYPE`、`CONFLUENCE_USERNAME` / `CONFLUENCE_EMAIL`、`CONFLUENCE_TOKEN` / `CONFLUENCE_PASSWORD`、`CONFLUENCE_SPACE`、`CONFLUENCE_ROOT_PAGE_ID` 和 `CONFLUENCE_DEPLOYMENT`。Cloud Basic 使用邮箱和 API token，Server/DC 支持 Basic 或 `bearer` PAT。自定义 Cloud 域名用 `--deployment cloud`。`readOnly: true` 或 `auth set --read-only true` 只允许读取和预览。

## 查找与续读

```text
search --query '发布 流程' --match all --space ENG --label release --start 0 --limit 15
read --page 123 --head 5
read --page 123 --format outline
read --page 123 --format storage --offset 0 --max-bytes 4096
read --page 123 --grep 发布 --context 30 --match-offset 0
read --pages 123,456 --start 0 --limit 2
scan --pages 123,456 --grep API --case-sensitive
children --page 123
attachments --page 123
download --page 123 --name diagram.png --output ./downloads
```

`--page` 和 `--parent` 接受 ID、带 ID 的页面 URL 或可唯一匹配的 display 链接。`search --parent` 直接在指定根页及其后代中搜索。若还要限制空间，同时指定 `--space`。省略 `--query` 可仅按范围或标签搜索，提供查询词时 `--match` 支持 `all|any|phrase`。默认响应预算含 JSON 与末尾换行，共 8192 个 UTF-8 字节。元信息或第一条命中放不下时，增加 `--max-bytes` 或减少 `--context`。`totalSize` 保留服务端统计，服务端省略时为 null。

`read` 默认返回 Wiki 文本。将 `nextOffset` 原样传给 `--offset`，文本坐标为 UTF-16 位置，outline 坐标为条目序号。`--head` 按行，`--grep` 按字面匹配，`--context` 按 UTF-16 长度；命中翻页用 `nextMatchOffset`。`--format full` 返回可按块拼接的 JSON 文本，含页面元数据、原始正文、Wiki 和索引。批量用 `nextStart` 继续，单页截断用返回的 ID 单独续读。两次读取之间页面版本改变时，从新版本重新定位。下载可按 `--id` 或唯一文件名，省略选择器则下载全部附件。

## 页面写入

```text
create --parent 123 --title 发布说明 --wiki-file ./release.wiki --layout right-toc
create --space ENG --title 项目约定 --storage-file ./page.xhtml
update --page 123 --mode replace-section --section r1-s2 --region r1 --wiki-file ./section.wiki --expected-version 7 --minor-edit --message 修订步骤
update --page 123 --mode append --region r1 --storage-file ./append.xhtml
upload --page 123 --file ./diagram.png --file ./notes.pdf
move --page 456 --parent 123
delete --page 123 --keep-root
restore --page 456 --parent 123
```

短正文可用 `--wiki` 或 `--storage`。Server/DC 用服务端转换 Wiki。Cloud 在本地处理标题、列表、表格、链接、附件图片、行内代码、成对代码块和提示框、`{toc}` 及 `{jira:key=APP-42}`，再提交服务端渲染校验。复杂宏、合并单元格和需要精确排版的内容用 Storage。布局 `right-toc` 在右栏放目录，`plain` 保留传入布局。局部替换保留原章节标题，直到同区域下一个同级或更高级标题；同名章节用 outline ID。整页替换用 `--mode replace`。更新提交必须带预览的 `--expected-version`。

上传同名附件生成新版本。单次移入回收站最多 100 页。核对预览并取得用户确认后，删除命令加 `--apply --confirm-title "预览中的精确标题" --expected-tree 预览中的treeHash`；保留原有 `--keep-root` 设置。`restore` 恢复指定单页，带父页时检查恢复后的实际位置。其他写命令用原预览参数加 `--apply` 提交。

`--minor-edit` 随页面版本提交。Cloud 页面关注者仍可能收到更新通知。[Atlassian 对 Cloud 通知的说明](https://jira.atlassian.com/browse/CONFCLOUD-38804)
