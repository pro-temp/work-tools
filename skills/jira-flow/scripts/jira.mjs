#!/usr/bin/env node
import { batch, choice, csv, downloadFiles, fail, fieldsFile, input, localFiles, multipart, partial, required, runCli } from './lib/runtime.mjs'
import { assignee, attachmentList, createContext, history, issue, issuePath, oneProject, projects, rest, search, sprintField, sprints, userField, users } from './lib/jira-api.mjs'

const edits = 'summary description body-file assignee sprint priority labels fields-file'
const uploads = 'file* image*'
const spec = { name: 'jira', scopeFlags: 'project', commands: {
  search: ['', 'project assignee sprint type status text start limit with-description! jql', '按条件或 JQL 查找任务'],
  issue: ['<KEY>', 'format full!', '读取任务详情、评论、附件、关联和子任务'],
  history: ['<KEY...>', 'fields', '并发查看变更历史'],
  transitions: ['<KEY>', '', '显示可用流转、字段与允许值'],
  'create-context': ['', 'project type', '查询项目可创建的类型与字段'],
  users: ['', 'project query', '查找可分配用户'],
  sprints: ['', 'project state', '列出 Scrum 看板的迭代'],
  attachments: ['<KEY>', '', '查看附件清单'],
  download: ['<KEY>', 'id name output', '保存附件到目录'],
  create: ['', 'project type parent ' + edits + ' ' + uploads + ' apply!', '预览或创建任务及附件'],
  update: ['<KEY>', edits + ' expected-updated apply!', '预览或更新任务字段'],
  comment: ['<KEY>', 'body body-file apply!', '预览或追加评论'],
  transition: ['<KEY>', 'transition-id to comment comment-file fields-file expected-updated apply!', '预览或提交流转'],
  attach: ['<KEY>', uploads + ' apply!', '校验或上传本地文件'],
} }

async function buildFields(api, o, project, context) {
  const fields = await fieldsFile(o['fields-file'])
  for (const name of ['project', 'issuetype', 'status']) if (Object.hasOwn(fields, name)) fail('字段不可通过 --fields-file 修改：' + name)
  function set(key, value) {
    if (value === undefined) return
    if (Object.hasOwn(fields, key)) fail('重复指定字段：' + key)
    fields[key] = value
  }
  if (context) {
    set('project', { key: project })
    set('issuetype', { id: context.issueType.id })
  }
  set('summary', o.summary)
  if ('summary' in fields && (typeof fields.summary !== 'string' || !fields.summary.trim() || fields.summary.length > 255))
    fail('标题须为 1 至 255 个字符')
  set('description', await input(o, 'description', 'body-file'))
  if (o.assignee) set('assignee', await assignee(api, project, o.assignee))
  if (o.priority) set('priority', /^\d+$/.test(o.priority) ? { id: o.priority } : { name: o.priority })
  if (o.labels !== undefined) set('labels', o.labels === '' ? [] : csv(o.labels))
  if (o.parent) { issuePath(o.parent); set('parent', { key: o.parent.toUpperCase() }) }
  if (o.sprint) set(...await sprintField(api, project, o.sprint, context?.fields))
  if (!Object.keys(fields).length) fail('没有要修改的字段')
  return fields
}

function validate(fields, definitions, creating) {
  const missing = []
  for (const [key, def] of Object.entries(definitions)) {
    const value = fields[key]
    if (def.required && !(creating && def.hasDefaultValue) && (value == null || value === '' || (Array.isArray(value) && !value.length))) {
      missing.push({ key, name: def.name, allowedValues: def.allowedValues })
    }
    if (value != null && def.allowedValues?.length) {
      for (const selected of Array.isArray(value) ? value : [value]) {
        const allowed = def.allowedValues.some(item => {
          if (selected === null) return false
          if (typeof selected !== 'object') return item === selected || [item.id, item.name, item.value].includes(selected)
          return ['id', 'name', 'value', 'key', 'accountId'].some(k => selected[k] !== undefined && String(item[k]) === String(selected[k]))
        })
        if (!allowed) fail(`${key} 的取值不在允许列表内：${JSON.stringify(def.allowedValues)}`)
      }
    }
  }
  return missing
}

async function prepareFiles(api, o, needed) {
  const paths = [...(o.file ?? []), ...(o.image ?? [])]
  if (!paths.length) {
    if (needed) fail('请提供 --file 或 --image')
    return []
  }
  const meta = await api.get(rest + 'attachment/meta')
  if (meta.enabled !== true) fail('Jira 未启用附件')
  if (!Number.isSafeInteger(meta.uploadLimit) || meta.uploadLimit < 0) fail('Jira 附件大小限制无效')
  return localFiles(paths, meta.uploadLimit)
}

async function upload(api, key, files) {
  const results = []
  for (const file of files) {
    try {
      const data = await api.request(issuePath(key) + '/attachments', { method: 'POST', body: await multipart(file) })
      if (!Array.isArray(data) || data.length !== 1 || !data[0].id) fail('附件回执不完整，请先核实附件清单')
      results.push({ file: file.path, uploaded: true, id: data[0].id })
    } catch (e) { results.push({ file: file.path, error: e.message, status: e.status >= 400 && e.status < 500 ? 'rejected' : 'unconfirmed' }) }
  }
  return results
}

async function withUploads(api, receipt, files) {
  const results = await upload(api, receipt.key, files)
  const result = { ...receipt, files: results }
  return results.some(r => r.error) ? partial({ ...result, next: `请核对 attachments ${receipt.key}，仅用 attach ${receipt.key} 补传缺失文件。` }) : result
}

async function versions(api, path, expected) {
  const { fields } = await api.get(path, { fields: 'updated,project' })
  required(fields.updated, 'Jira 详情 updated')
  if (expected !== undefined && expected !== fields.updated) fail('任务已变化，请重新读取详情 updated 并预览')
  return fields
}

const transitions = async (api, path) => (await api.get(path + '/transitions', { expand: 'transitions.fields' })).transitions

async function execute(command, o, keys, api) {
  const key = keys[0]?.toUpperCase()
  if (command === 'doctor') {
    const me = await api.get(rest + 'myself')
    required(me.accountId || me.name, 'Jira 当前用户标识')
    const scopes = api.profile.project ? await Promise.all(projects(api).map(p => api.get(rest + 'project/' + encodeURIComponent(p)))) : []
    return { user: me.displayName, id: me.accountId || me.name, projects: scopes.map(p => p.key) }
  }
  if (command === 'search') return search(api, o)
  if (command === 'issue') return issue(api, key, o)
  if (command === 'history') {
    const wanted = o.fields ? csv(o.fields.toLowerCase()) : undefined
    const results = await batch(keys, k => history(api, k.toUpperCase(), wanted))
    return results.some(r => r.error) ? partial({ results }) : { results }
  }
  if (command === 'create-context') return createContext(api, oneProject(api, o.project), o.type)
  if (command === 'users') return users(api, oneProject(api, o.project), required(o.query, '--query'))
  if (command === 'sprints') return sprints(api, projects(api, o.project), o.state ? choice(o.state, ['active', 'future', 'closed'], '--state') : 'active,future')
  if (command === 'create') {
    const project = oneProject(api, o.project)
    const ctx = await createContext(api, project, required(o.type, '--type（可从 create-context 选择）'))
    const fields = await buildFields(api, o, project, ctx)
    for (const name of Object.keys(fields)) {
      if (!['project', 'issuetype'].includes(name) && !Object.hasOwn(ctx.fields, name)) fail('创建界面不支持字段 ' + name)
    }
    const reporter = ctx.fields.reporter
    if (reporter?.required && !reporter.hasDefaultValue && fields.reporter === undefined)
      fields.reporter = userField(await api.get(rest + 'myself'))
    const missing = validate(fields, ctx.fields, true)
    if (!fields.summary && !missing.some(v => v.key === 'summary')) missing.push({ key: 'summary' })
    if (ctx.issueType.subtask && !fields.parent && !missing.some(v => v.key === 'parent')) missing.push({ key: 'parent' })
    const files = await prepareFiles(api, o, false)
    if (!o.apply) return { preview: true, ready: !missing.length, fields, missing, files }
    if (missing.length) fail('缺少必填字段：' + JSON.stringify(missing))
    const receipt = await api.request(rest + 'issue', { method: 'POST', body: { fields } })
    if (!receipt?.key) fail('建单回执缺少 key，请在 Jira 核实后再操作')
    return withUploads(api, { created: true, key: receipt.key, id: receipt.id }, files)
  }
  const path = issuePath(key)
  if (command === 'attachments' || command === 'download') {
    const rows = attachmentList((await api.get(path, { fields: 'attachment' })).fields)
    if (!rows) fail('Jira 未返回 attachment 字段，请检查附件功能和可见权限')
    return command === 'download' ? downloadFiles(api, rows, o) : rows
  }
  if (command === 'transitions') return transitions(api, path)
  const current = await versions(api, path, o['expected-updated'])
  const preview = { preview: true, key, updated: current.updated }
  if (command === 'attach') {
    const files = await prepareFiles(api, o, true)
    return o.apply ? withUploads(api, { key }, files) : { ...preview, files }
  }
  if (command === 'comment') {
    const body = required(await input(o, 'body'), '--body 或 --body-file')
    if (!o.apply) return { ...preview, body }
    const result = await api.request(path + '/comment', { method: 'POST', body: { body } })
    return { key, commentId: required(result.id, '评论回执 ID') }
  }
  let endpoint = path, method = 'PUT', body
  if (command === 'update') {
    body = { fields: await buildFields(api, o, current.project.key) }
  } else {
    if (Boolean(o['transition-id']) === Boolean(o.to)) fail('请选择 --transition-id 或 --to')
    const options = await transitions(api, path)
    const matches = options.filter(t => o.to ? t.to.name === o.to : String(t.id) === o['transition-id'])
    if (matches.length !== 1) fail('流转目标未唯一匹配：' + JSON.stringify(options.map(t => ({ id: t.id, to: t.to.name }))))
    const t = matches[0]
    const fields = await fieldsFile(o['fields-file'])
    if (Object.hasOwn(fields, 'comment')) fail('流转评论请用 --comment 或 --comment-file')
    const comment = await input(o, 'comment')
    const missing = validate({ ...fields, comment: comment?.trim() }, t.fields, false)
    if (missing.length) fail('流转缺少必填字段：' + JSON.stringify(missing))
    endpoint += '/transitions'
    method = 'POST'
    body = { transition: { id: t.id }, fields, ...(comment && { update: { comment: [{ add: { body: comment } }] } }) }
  }
  if (!o.apply) return { ...preview, ...body }
  if (o['expected-updated'] !== undefined) await versions(api, path, o['expected-updated'])
  await api.request(endpoint, { method, body })
  return { applied: true, key }
}

await runCli(spec, execute)
