import { choice, csv, fail, integer, required, unavailable } from './runtime.mjs'
import { wikiMarkdown } from './wiki.mjs'

export const rest = 'rest/api/2/'
const agile = 'rest/agile/1.0/'
export const issueFields = ['summary', 'project', 'issuetype', 'status', 'assignee', 'priority', 'updated']

export function issuePath(key) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) fail('无效的 Jira issue key：' + key)
  return rest + 'issue/' + key.toUpperCase()
}

export function projects(api, value = api.profile.project) {
  return csv(required(value, '--project（多项目用逗号分隔）'))
}

export function oneProject(api, value) {
  const result = projects(api, value)
  if (result.length !== 1) fail('此操作需要指定一个项目')
  return result[0]
}

function quote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' }

export function searchJql(o, defaultProject) {
  if (o.jql !== undefined && ['project', 'assignee', 'sprint', 'type', 'status', 'text'].some(key => o[key] !== undefined))
    fail('--jql 不能与结构化筛选混用')
  const clauses = []
  let scope = o.project ?? defaultProject
  let order = 'ORDER BY updated DESC'
  if (o.jql !== undefined) {
    const jql = required(o.jql, '--jql').trim()
    // Consume quoted literals whole. Only project in the filter selects a scope.
    const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\bproject\b|\border\s+by\b/gi
    let end = jql.length
    for (const token of jql.matchAll(tokens)) {
      if (/^order/i.test(token[0])) {
        end = token.index
        order = jql.slice(end)
        break
      }
      if (token[0].toLowerCase() === 'project') scope = undefined
    }
    const body = jql.slice(0, end).trim()
    if (body) clauses.push('(' + body + ')')
  }
  if (scope && scope !== 'all') clauses.unshift('project IN (' + csv(scope).map(quote).join(', ') + ')')
  if (o.assignee === 'none') clauses.push('assignee IS EMPTY')
  else if (o.assignee && o.assignee !== 'all') clauses.push('assignee = ' + (o.assignee === 'me' ? 'currentUser()' : quote(o.assignee)))
  if (o.sprint === 'current') clauses.push('sprint in openSprints()')
  else if (o.sprint === 'none') clauses.push('sprint IS EMPTY')
  else if (o.sprint && o.sprint !== 'all') clauses.push('sprint = ' + (/^\d+$/.test(o.sprint) ? o.sprint : quote(o.sprint)))
  for (const [key, field, op] of [['type', 'issuetype', '='], ['status', 'status', '='], ['text', 'text', '~']])
    if (o[key]) clauses.push(`${field} ${op} ${quote(o[key])}`)
  // Cloud enhanced search requires a predicate even when all projects are requested.
  if (scope === 'all' && !clauses.length) clauses.push('project IS NOT EMPTY')
  return (clauses.length ? clauses.join(' AND ') + ' ' : '') + order
}

export function summary(raw) {
  const f = raw.fields
  return { key: raw.key, summary: f.summary, project: f.project.key, type: f.issuetype.name,
    status: f.status.name, assignee: f.assignee?.displayName ?? null, priority: f.priority?.name, updated: f.updated }
}

export async function search(api, o) {
  const start = integer(o.start ?? 0, '--start')
  const limit = integer(o.limit ?? 25, '--limit', 1)
  const jql = searchJql(o, api.profile.project)
  const fields = o['with-description'] ? [...issueFields, 'description'] : issueFields
  const issues = []
  let cloud = api.profile.deployment === 'cloud'
  let position = cloud ? 0 : start
  let token
  let more = true
  let total = null
  const seen = new Set()
  while (more && issues.length < limit) {
    const maxResults = Math.min(100, start + limit - position)
    const body = { jql, fields, maxResults, ...(cloud ? { nextPageToken: token } : { startAt: position }) }
    let page
    try { page = await api.request(rest + (cloud ? 'search/jql' : 'search'), { method: 'POST', body }) }
    catch (e) {
      if (cloud || issues.length || !unavailable(e)) throw e
      cloud = true
      position = 0
      continue
    }
    for (const row of page.issues) {
      if (position++ >= start && issues.length < limit)
        issues.push({ ...summary(row), ...(o['with-description'] && { description: wikiMarkdown(row.fields.description) }) })
    }
    if (cloud) {
      token = page.nextPageToken
      more = Boolean(token)
      if (more && seen.has(token)) fail('Jira 搜索游标没有前进')
      seen.add(token)
      if (!more) total = position
    } else {
      total = integer(page.total, 'Jira total')
      more = position < total
    }
    if (more && !page.issues.length) fail('Jira 搜索分页没有前进')
  }
  return { issues, total, nextStart: more ? position : null, jql }
}

export async function pages(api, path, query, keys) {
  const rows = []
  for (;;) {
    const page = await api.get(path, { ...query, startAt: rows.length, maxResults: 100 })
    const values = keys.map(key => page[key]).find(Array.isArray)
    if (!values) fail('Jira 分页响应缺少 ' + keys.join('/'))
    rows.push(...values)
    if (page.isLast === true || rows.length >= page.total) return rows
    if (page.isLast === undefined && page.total === undefined) {
      if (values.length < page.maxResults) return rows
      if (!Number.isInteger(page.maxResults)) fail('Jira 缺少分页结束标记')
    }
    if (!values.length) fail('Jira 元数据分页没有前进')
  }
}

export async function createContext(api, project, type) {
  const path = rest + 'issue/createmeta'
  const scoped = path + '/' + encodeURIComponent(project) + '/issuetypes'
  let types, legacy = false
  try { types = await pages(api, scoped, {}, ['values', 'issueTypes']) }
  catch (e) {
    if (!unavailable(e)) throw e
    const data = await api.get(path, { projectKeys: project, expand: 'projects.issuetypes.fields' })
    const match = data.projects.find(p => p.key.toLowerCase() === project.toLowerCase())
    if (!match) fail('项目不存在或无创建权限：' + project)
    types = match.issuetypes
    legacy = true
  }
  const issueTypes = types.map(t => ({ id: t.id, name: t.name, subtask: t.subtask }))
  if (!type) return { project, issueTypes }
  const matches = types.filter(t => String(t.id) === type || t.name.toLowerCase() === type.toLowerCase())
  if (matches.length !== 1) fail('请选择项目中的唯一类型：' + JSON.stringify(issueTypes))
  const selected = matches[0]
  const fields = legacy ? selected.fields : Object.fromEntries(
    (await pages(api, scoped + '/' + encodeURIComponent(selected.id), {}, ['values', 'fields'])).map(f => [required(f.fieldId || f.key, '字段 ID'), f]))
  return { project, issueTypes, issueType: { id: selected.id, name: selected.name, subtask: selected.subtask }, fields }
}

export async function users(api, project, query) {
  const me = await api.get(rest + 'myself')
  const cloud = Boolean(me.accountId)
  const term = query === 'me' ? me.accountId || me.name : required(query, '--query')
  const path = rest + 'user/assignable/search'
  const parameter = cloud ? (me.accountId === term ? 'accountId' : 'query') : 'username'
  const get = (key, startAt) => api.get(path, { project, [key]: term, startAt, maxResults: 1000 - startAt })
  let rows = await get(parameter, 0)
  let exactId = parameter === 'accountId'
  if (cloud && parameter === 'query' && !rows.length) {
    try { rows = await get('accountId', 0); exactId = true }
    catch (e) { if (![400, 404].includes(e.status)) throw e }
  }
  const found = new Map()
  let offset = 0
  while (rows.length) {
    const before = found.size
    for (const user of rows) found.set(required(user.accountId || user.name, '可分配用户 ID'), user)
    offset += rows.length
    if (exactId || offset >= 1000 || found.size === before) break
    rows = await get(parameter, offset)
  }
  return { users: [...found.values()].filter(u => u.active !== false).map(u => ({ name: u.name, accountId: u.accountId, displayName: u.displayName })),
    complete: exactId || rows.length === 0, term }
}

export function userField(user) {
  return user.accountId ? { accountId: user.accountId } : { name: required(user.name, 'Jira username') }
}

export async function assignee(api, project, query) {
  if (query === 'none') return null
  const result = await users(api, project, query)
  const exact = result.users.filter(u => u.accountId === result.term || u.name === result.term)
  const matches = exact.length ? exact : result.users.filter(u => u.displayName === query)
  if (matches.length !== 1 || (!exact.length && !result.complete)) fail('经办人未唯一匹配，请指定 username/accountId：' + JSON.stringify(result.users))
  return userField(matches[0])
}

export async function sprints(api, keys, state) {
  const found = new Map()
  for (const project of keys) {
    const boards = await pages(api, agile + 'board', { projectKeyOrId: project, type: 'scrum' }, ['values'])
    for (const board of boards) {
      const rows = await pages(api, agile + 'board/' + board.id + '/sprint', { state }, ['values'])
      for (const row of rows) {
        if (!found.has(row.id)) found.set(row.id, { id: row.id, name: row.name, state: row.state, boards: [] })
        found.get(row.id).boards.push({ project, id: board.id, name: board.name })
      }
    }
  }
  return [...found.values()]
}

export async function sprintField(api, project, term, metadata) {
  const fields = metadata ? Object.entries(metadata).map(([id, field]) => ({ ...field, id })) : await api.get(rest + 'field')
  const candidates = fields.filter(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')
  if (candidates.length !== 1) fail('无法从 Jira 元数据确定唯一 Sprint 字段')
  if (term === 'none') return [candidates[0].id, null]
  const active = term === 'current'
  const options = await sprints(api, [project], active ? 'active' : 'active,future')
  const matches = options.filter(s => active || String(s.id) === term || s.name === term)
  if (matches.length !== 1) fail('迭代未唯一匹配，请指定 ID：' + JSON.stringify(options))
  return [candidates[0].id, matches[0].id]
}

export async function history(api, key, wanted) {
  const path = issuePath(key)
  const { changelog } = await api.get(path, { fields: 'updated', expand: 'changelog' })
  let rows = changelog.histories
  let complete = rows.length >= integer(changelog.total, 'changelog.total')
  if (!complete) {
    try { rows = await pages(api, path + '/changelog', {}, ['values', 'histories']); complete = true }
    catch (e) { if (!unavailable(e)) throw e }
  }
  return { key, complete, histories: rows.flatMap(h => {
    const items = h.items.filter(i => !wanted || wanted.includes(i.fieldId?.toLowerCase()) || wanted.includes(i.field.toLowerCase()))
      .map(i => ({ field: i.field, fieldId: i.fieldId, from: i.fromString, to: i.toString }))
    return items.length ? [{ created: h.created, author: h.author?.displayName, items }] : []
  }) }
}

export function attachmentList(fields) {
  return fields.attachment?.map(a => ({ id: a.id, name: a.filename, size: a.size, mediaType: a.mimeType, url: a.content }))
}

export async function issue(api, key, o) {
  const path = issuePath(key)
  const format = choice(o.format ?? 'markdown', ['json', 'markdown'], '--format')
  const raw = await api.get(path, { fields: o.full ? '*all' : [...issueFields, 'description', 'labels', 'reporter', 'attachment', 'issuelinks', 'subtasks'].join(',') })
  const f = raw.fields
  const commentPath = path + '/comment'
  const page = o.full ? null : await api.get(commentPath, { startAt: 0, maxResults: 10, orderBy: '-created' })
  const comments = (o.full ? await pages(api, commentPath, { orderBy: 'created' }, ['comments']) : page.comments)
    .map(c => ({ id: c.id, author: c.author?.displayName, created: c.created, body: wikiMarkdown(c.body) }))
  const result = { ...summary(raw), reporter: f.reporter?.displayName, labels: f.labels, description: wikiMarkdown(f.description),
    comments, commentTotal: page ? page.total : comments.length, attachments: attachmentList(f),
    links: f.issuelinks?.map(l => ({ relation: l.inwardIssue ? l.type.inward : l.type.outward, key: (l.inwardIssue || l.outwardIssue).key })),
    subtasks: f.subtasks?.map(t => ({ key: t.key, summary: t.fields.summary })), ...(o.full && { raw }) }
  if (format === 'json') return result
  const lines = [`# ${result.key} ${result.summary}`, `${result.project} · ${result.type} · ${result.status} · ${result.assignee ?? '未分配'}`,
    `更新时间 ${result.updated}`, `优先级 ${result.priority ?? '—'} · 报告人 ${result.reporter ?? '—'}`, result.description,
    `## 评论（${comments.length}/${result.commentTotal}）`, ...comments.map(c => `- ${c.author} ${c.created}\n  ${c.body}`),
    '## 附件', ...(result.attachments?.map(a => `- ${a.name} (#${a.id}, ${a.size} B)`) ?? ['附件字段不可见']),
    '## 关联与子任务', ...(result.links?.map(l => `- ${l.relation} ${l.key}`) ?? ['关联字段不可见']),
    ...(result.subtasks?.map(t => `- ${t.key} ${t.summary}`) ?? ['子任务字段不可见'])]
  if (o.full) lines.push('## Jira 原始字段', JSON.stringify(raw, null, 2))
  return lines.join('\n\n')
}
