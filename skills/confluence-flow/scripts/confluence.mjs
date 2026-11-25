#!/usr/bin/env node
import { choice, downloadFiles, fail, input, integer, localFiles, multipart, partial, required, runCli } from './lib/runtime.mjs'
import { service } from './lib/confluence-api.mjs'
import { editStorage, layout } from './lib/storage.mjs'
import { readPages } from './lib/reading.mjs'
import { restore, trash } from './lib/trash.mjs'

const sources = 'wiki wiki-file storage storage-file'
const reading = 'page pages grep context case-sensitive! match-offset max-bytes start limit'
const spec = { name: 'confluence', scopeFlags: 'space root-page-id', commands: {
  search: ['', 'query space parent label match start limit max-bytes', 'CQL 搜索并按字节预算返回摘要'],
  read: ['', reading + ' format head offset', '读取页面、章节索引或字面命中'],
  scan: ['', reading, '批量摘要或检索命中'],
  children: ['', 'page start limit', '查看直接子页'],
  attachments: ['', 'page', '查看页面附件'],
  download: ['', 'page id name output', '保存页面附件'],
  create: ['', 'parent space title layout ' + sources + ' apply!', '预览或发布页面'],
  update: ['', 'page mode section region title layout minor-edit! message expected-version ' + sources + ' apply!', '预览或按版本更新页面'],
  upload: ['', 'page file* apply!', '预览或上传附件，同名更新版本'],
  move: ['', 'page parent apply!', '预览或移动到同空间父页'],
  delete: ['', 'page keep-root! confirm-title expected-tree apply!', '查看受影响树或移入回收站'],
  restore: ['', 'page parent apply!', '查看或恢复回收站页面'],
} }

async function content(api, o, pageId) {
  const wiki = await input(o, 'wiki'), storage = await input(o, 'storage')
  if ((wiki !== undefined) === (storage !== undefined)) fail('请提供一种正文来源：--wiki / --wiki-file 或 --storage / --storage-file')
  return storage === undefined ? api.convert(wiki, pageId) : storage
}

async function upload(api, id, o) {
  await api.page(id)
  const files = await localFiles(required(o.file, '--file'))
  if (new Set(files.map(f => f.name)).size !== files.length) fail('同一批上传出现重名文件，请分开提交')
  const plans = []
  for (const file of files) {
    const matches = (await api.attachments(id, file.name)).filter(a => a.name === file.name)
    if (matches.length > 1) fail('服务器存在同名附件，无法唯一确定更新目标')
    plans.push({ ...file, existingId: matches[0]?.id, version: matches[0]?.version, action: matches.length ? 'new-version' : 'create' })
  }
  if (!o.apply) return { preview: true, id, files: plans }
  const results = []
  for (const file of plans) {
    try {
      const form = await multipart(file)
      const base = 'rest/api/content/' + id + '/child/attachment'
      const raw = await api.request(file.existingId ? base + '/' + encodeURIComponent(file.existingId) + '/data' : base, { method: 'POST', body: form })
      const receipt = raw?.results ? (raw.results.length === 1 && raw.results[0]) : raw
      if (!receipt?.id) fail('附件回执不完整，请核对附件清单')
      results.push({ file: file.name, id: receipt.id, action: file.action })
    } catch (e) { results.push({ file: file.name, error: e.message }) }
  }
  return results.some(r => r.error) ? partial({ id, files: results }) : { id, files: results }
}

async function execute(command, o, args, client) {
  const api = service(client)
  if (command === 'doctor') {
    const me = await api.get('rest/api/user/current')
    required(me.accountId || me.username || me.userKey, 'Confluence 当前用户标识')
    const space = api.profile.space ? await api.space(api.profile.space) : undefined
    const root = api.profile.rootPageId ? await api.page(await api.resolve(api.profile.rootPageId)) : undefined
    if (root && space && root.scope !== (api.cloud ? space.id : space.key)) fail('默认根页与空间不一致')
    return { user: me.displayName, id: me.accountId || me.username || me.userKey, space, root }
  }
  if (command === 'search') return api.search(o)
  if (command === 'read' || command === 'scan') return readPages(api, o, command === 'scan')
  if (command === 'create') {
    if (o.parent && o.space) fail('创建目标请选择 --parent 或 --space')
    const parent = o.parent ?? (o.space ? undefined : api.profile.rootPageId)
    const parentPage = parent ? await api.page(await api.resolve(parent)) : undefined
    const space = parentPage ? undefined : await api.space(o.space ?? api.profile.space)
    const scope = parentPage ? parentPage.scope : api.cloud ? space.id : space.key
    const title = required(o.title, '--title')
    const storage = layout(await content(api, o, parentPage?.id), choice(o.layout ?? 'plain', ['right-toc', 'plain'], '--layout'))
    const validation = await api.validate(storage, parentPage?.id)
    const plan = { title, scope, parent: parentPage?.id, storage }
    return o.apply ? { created: true, ...await api.save(plan) } : { preview: true, validation, ...plan }
  }
  const id = await api.resolve(required(o.page, '--page'))
  if (command === 'delete') return trash(api, id, o)
  if (command === 'restore') return restore(api, id, o.parent ? await api.resolve(o.parent) : undefined, o.apply)
  if (command === 'upload') return upload(api, id, o)
  if (command === 'attachments' || command === 'download') {
    const items = await api.attachments(id)
    return command === 'download' ? downloadFiles(api, items, o) : items
  }
  if (command === 'children') {
    const start = integer(o.start ?? 0, '--start'), limit = integer(o.limit ?? 50, '--limit', 1)
    const results = []
    let index = 0
    for await (const { rows } of api.children(id)) {
      for (const row of rows) {
        if (row.type && row.type !== 'page') continue
        if (index++ < start) continue
        if (results.length === limit) return { results, nextStart: start + limit }
        results.push({ id: row.id, title: row.title, version: row.version?.number })
      }
    }
    return { results, nextStart: null }
  }
  const current = await api.page(id, { body: command === 'update' || !api.cloud })
  if (command === 'move') {
    const parent = await api.resolve(required(o.parent, '--parent'))
    const plan = await api.movePlan(current, parent)
    return o.apply ? { moved: true, ...await api.move(current, parent) } : { preview: true, ...plan }
  }
  const mode = choice(required(o.mode, '--mode'), ['replace', 'append', 'replace-section'], '--mode')
  if (o.apply || o['expected-version'] !== undefined) {
    const expected = integer(required(o['expected-version'], '--expected-version（取自 read / 预览）'), '--expected-version', 1)
    if (expected !== current.version) fail('页面版本冲突，请重新读取并预览')
  }
  if (mode === 'replace-section') required(o.section, '--section')
  if ((o.section && mode !== 'replace-section') || (o.region && mode === 'replace') || (o.layout && mode !== 'replace'))
    fail('--section/--region 用于局部修改，--layout 用于整页替换')
  if (o.title !== undefined) required(o.title, '--title')
  const fragment = await content(api, o, id)
  const style = choice(o.layout ?? 'plain', ['plain', 'right-toc'], '--layout')
  const storage = editStorage(current.storage, layout(fragment, style), mode, o.section, o.region)
  const validation = await api.validate(storage, id)
  const plan = { id, scope: current.scope, title: o.title ?? current.title, storage,
    version: { number: current.version + 1, minorEdit: Boolean(o['minor-edit']), message: o.message } }
  return o.apply ? { updated: true, ...await api.save(plan) } : { preview: true, expectedVersion: current.version, validation, mode, ...plan }
}

await runCli(spec, execute)
