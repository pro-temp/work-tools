# Jira 操作参考

下列命令均接在 `node scripts/jira.mjs` 之后。`命令 --help` 显示该命令的完整参数。正常结果在 stdout，失败为 stderr JSON 和退出码 1，批量部分成功为 stdout JSON 和退出码 2。

## 连接

用户配置文件为 `~/.config/jira-flow/config.json`，可用 `JIRA_FLOW_CONFIG` 指定其他路径。下面的配置包含两个默认项目。

```json
{"defaultProfile":"work","profiles":{"work":{"baseUrl":"https://jira.example.org/jira","authType":"basic","username":"alice","project":"APP,OPS"}}}
```

以进程中的 `JIRA_TOKEN` 或 `JIRA_PASSWORD` 提供密钥。也可由用户在自己的终端从密码管理器通过管道输入 `auth set --secret-stdin`。保存后的凭证属于用户配置文件，Unix 权限为 0600。不要在聊天或 Skill 文件中填写密钥。

```text
auth set --profile work --base-url https://jira.example.org/jira --auth-type basic --username alice --project APP,OPS --make-default
config show --profile work
doctor --profile work
```

选择顺序为 `--profile`、`JIRA_FLOW_PROFILE`、`defaultProfile`。命令参数优先于环境变量，环境变量优先于所选 profile。支持 `JIRA_BASE_URL`、`JIRA_AUTH_TYPE`、`JIRA_USERNAME` / `JIRA_EMAIL`、`JIRA_TOKEN` / `JIRA_PASSWORD`、`JIRA_PROJECT` 和 `JIRA_DEPLOYMENT`。Cloud Basic 使用邮箱和 API token，Server/DC 支持 Basic 或 `bearer` PAT。自定义 Cloud 域名可用 `--deployment cloud`，Server/DC 用 `server`。只读连接由 `readOnly: true` 或 `auth set --read-only true` 指定，仍可预览。

## 查找和读取

```text
search --project APP,OPS --assignee me --sprint current --type Bug --status Open --text 登录 --limit 20
search --project all --assignee none
search --jql 'project = OPS AND status = Open'
search --jql 'status = Open OR priority = High ORDER BY updated DESC' --start 20 --with-description
issue APP-42 --format json
issue APP-42 --full --format markdown
history APP-42 OPS-8 --fields status,assignee,resolution
create-context --project APP
create-context --project APP --type Bug
users --project APP --query Alice
sprints --project APP,OPS --state active
transitions APP-42
attachments APP-42
download APP-42 --id 107 --output ./downloads
```

结构化搜索默认使用 profile 的项目，`--project all` 查询账号可见的所有项目。`--assignee none` 只查未分配工单，`me` 查本人，`all` 或省略则查全部，也可指定用户名或 ID。迭代支持 `current|all|none|ID 或名称`，省略时查全部。

`--jql` 单独使用。筛选表达式在引号外含有 `project` 时，以表达式指定的项目为准，否则沿用 profile 的默认项目范围。引号内的文本和 `ORDER BY project` 都不会改变搜索范围。

`nextStart` 可续页，Cloud 可能只给出游标，在读取末页前 `total` 为 null。详情默认显示最近十条评论，`--full` 取完整字段和全部评论。历史 `complete: false` 表示旧服务器只返回了部分记录。下载也可按唯一 `--name`，省略选择器则保存全部附件，已有同名本地文件会报错。

## 准备写入

```text
create --project APP --type Bug --summary 修复登录 --body-file ./description.txt --priority High --assignee alice --labels web,login --sprint 17 --file ./report.pdf --image ./screen.png
create --project APP --type Sub-task --parent APP-42 --summary 补充测试 --fields-file ./fields.json
update APP-42 --body-file ./description.txt --labels web --expected-updated 2026-10-20T10:00:00.123+0800
comment APP-42 --body-file ./comment.txt
transition APP-42 --to 完成 --comment-file ./comment.txt --fields-file ./transition.json
attach APP-42 --image ./screen.png --file ./trace.txt
```

`--description`、`--body`、`--comment` 可直接提供短文本。字段文件是 Jira `fields` 内层 JSON 对象，按元数据给出字段 ID 和值，例如 `{"customfield_10042":{"id":"19"}}`。指定 `--assignee none` 可取消分配，`--sprint none` 可清空迭代。创建时省略这些字段会保留项目默认行为。流转重名时改用 `--transition-id`。对照预览后，使用原命令加 `--apply` 提交。

若项目要求填写报告人且没有默认值，创建预览会使用当前登录账号。要指定其他报告人，在 `--fields-file` 的 `reporter` 字段中填写 Cloud 的 `accountId` 或 Server/DC 的 `name`。
