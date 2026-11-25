import { setTimeout as delay } from 'node:timers/promises'
import { choice, fail, integer, required, unavailable } from './runtime.mjs'
import { parseStorage, wikiStorage } from './storage.mjs'
import { fitRows } from './reading.mjs'

const v1 = 'rest/api/'
const v2 = 'api/v2/'
const q = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

export function service(api) {
  const { profile, get, request } = api
  const cloud = profile.deployment === 'cloud'
  const base = new URL(profile.baseUrl + '/')

  function siteLink(link) {
    if (link.startsWith('/') && !link.startsWith('//') && !link.startsWith(base.pathname))
      return new URL(link.slice(1), base).href
    return new URL(link, base).href
  }

  async function space(value, byId = false) {
    required(value, '--space')
    if (!cloud) {
      const s = await get(v1 + 'space/' + encodeURIComponent(value), { expand: 'homepage' })
      return { key: s.key, id: s.id, homepage: s.homepage?.id }
    }
    const data = byId ? await get(v2 + 'spaces/' + encodeURIComponent(value)) : await get(v2 + 'spaces', { keys: value })
    const s = byId ? data : data.results.find(s => s.key === value)
    if (!s) fail('找不到空间 ' + value)
    return { key: s.key, id: s.id, homepage: s.homepageId }
  }

  async function resolve(reference) {
    required(reference, '--page 或 --parent')
    if (/^\d+$/.test(reference)) return String(reference)
    const u = new URL(reference)
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname) || u.username || u.password) fail('页面 URL 不属于当前连接')
    const id = u.searchParams.get('pageId') || u.pathname.match(/\/pages\/(\d+)(?:\/|$)/)?.[1]
    if (id && /^\d+$/.test(id)) return id
    const display = u.pathname.match(/\/display\/([^/]+)\/(.+)$/)
    if (display) {
      const key = decodeURIComponent(display[1]), title = decodeURIComponent(display[2].replace(/\+/g, ' '))
      const found = cloud ? await get(v2 + 'pages', { 'space-id': (await space(key)).id, title, limit: 2 }) :
        await get(v1 + 'content', { type: 'page', spaceKey: key, title, limit: 2 })
      if (found.results.length === 1) return String(found.results[0].id)
    }
    fail('无法唯一确定页面，请提供页面 ID 或包含 ID 的页面链接')
  }

  async function page(id, { body = false, status = 'current', operations = false } = {}) {
    const raw = cloud ? await get(v2 + 'pages/' + id, { status, 'body-format': body ? 'storage' : undefined, 'include-operations': operations || undefined }) :
      await get(v1 + 'content/' + id, { status, expand: ['space', 'version', 'ancestors', ...(body ? ['body.storage'] : []), ...(operations ? ['operations'] : [])].join(',') })
    if ((!cloud && raw.type !== 'page') || String(raw.id) !== id || raw.status !== status ||
      typeof raw.title !== 'string' || !Number.isSafeInteger(raw.version?.number) || raw.version.number < 1)
      fail('页面身份、状态、标题或版本无效，请重新读取')
    const scope = required(cloud ? raw.spaceId : raw.space?.key, '页面空间')
    const ancestors = cloud ? undefined : raw.ancestors.map(p => String(p.id))
    const storage = body ? raw.body?.storage?.value : undefined
    if (body && typeof storage !== 'string') fail('服务器缺少原始 storage 正文')
    const ops = cloud ? raw.operations?.results : raw.operations
    return { id, title: raw.title, version: raw.version.number, scope, parent: cloud ? raw.parentId ?? null : ancestors.at(-1) ?? null,
      ancestors, storage, canDelete: ops?.some(r => r.operation === 'delete' && r.targetType === 'page') }
  }

  // Follow the server's pagination parameters on the original API path. Never use a next-link host for a credentialed request.
  async function* batches(path, query, start = 0) {
    let params = cloud ? { ...query } : { ...query, start }
    let skip = cloud ? start : 0
    const seen = new Set()
    for (;;) {
      const data = await get(path, params)
      const cursor = (Number.isSafeInteger(data.start) ? data.start : (params.start ?? 0)) + data.results.length
      const next = data._links?.next || (!cloud && Number.isSafeInteger(data.totalSize) && data.results.length > 0 && cursor < data.totalSize ? cursor : null)
      const rows = data.results.slice(skip)
      skip = Math.max(0, skip - data.results.length)
      yield { rows, next, total: data.totalSize }
      if (!next) return
      if (!data.results.length || seen.has(next)) fail('Confluence 分页没有前进')
      seen.add(next)
      params = typeof next === 'number' ? { ...query, start: next } : { ...query, ...Object.fromEntries(new URL(next, base).searchParams) }
    }
  }

  function children(id) {
    return batches(cloud ? v2 + 'pages/' + id + '/direct-children' : v1 + 'content/' + id + '/child/page',
      cloud ? { limit: 100 } : { expand: 'version', limit: 100 })
  }

  async function attachments(id, filename) {
    const items = []
    const path = cloud ? v2 + 'pages/' + id + '/attachments' : v1 + 'content/' + id + '/child/attachment'
    for await (const { rows } of batches(path, { filename, limit: 100, expand: cloud ? undefined : 'version' })) {
      for (const a of rows) {
        const link = cloud ? a.downloadLink || a._links?.download : a._links?.download
        items.push({ id: String(a.id), name: a.title, version: a.version.number,
          size: cloud ? a.fileSize : a.extensions?.fileSize, url: link && siteLink(link) })
      }
    }
    return items
  }

  async function search(o) {
    const start = integer(o.start ?? 0, '--start'), limit = integer(o.limit ?? 25, '--limit', 1)
    const budget = integer(o['max-bytes'] ?? 8192, '--max-bytes', 1)
    const clauses = ['type=page']
    const match = choice(o.match ?? 'all', ['all', 'any', 'phrase'], '--match')
    const query = o.query === undefined ? undefined : required(o.query, '--query')
    const scope = o.space ?? (o.parent ? undefined : profile.space)
    if (scope) clauses.push('space=' + q(scope))
    const parent = o.parent ?? (o.space ? undefined : profile.rootPageId)
    if (parent) {
      const id = await resolve(parent)
      clauses.push(`(id=${id} OR ancestor=${id})`)
    }
    if (o.label) clauses.push('label=' + q(o.label))
    if (query) {
      const terms = match === 'phrase' ? ['"' + query + '"'] : query.trim().split(/\s+/)
      clauses.push('(' + terms.map(t => 'text~' + q(t)).join(match === 'any' ? ' OR ' : ' AND ') + ')')
    }
    const results = []
    let nextStart = null, totalSize = null
    const cql = clauses.join(' AND ') + ' ORDER BY lastmodified DESC'
    for await (const b of batches(v1 + 'search', { cql, limit: Math.min(100, cloud ? start + limit : limit), expand: 'content.version,content.space' }, start)) {
      const wanted = limit - results.length
      for (const r of b.rows.slice(0, wanted)) {
        const excerpt = (r.excerpt || '').replace(/<[^>]+>|@@@(?:end)?hl@@@/g, '')
          .replace(/&(lt|gt|amp|quot|nbsp|#39);/g, (_, k) => ({ lt: '<', gt: '>', amp: '&', quot: '"', nbsp: ' ', '#39': "'" })[k])
          .replace(/[ \t]*\r?\n[ \t\r\n]*/g, '\n').trim().slice(0, 220)
        results.push({ id: r.content.id, title: r.content.title, space: r.content.space?.key, version: r.content.version?.number,
          updated: r.lastModified, excerpt })
      }
      totalSize = b.total ?? null
      nextStart = b.next || b.rows.length > wanted || (totalSize !== null && start + results.length < totalSize) ? start + results.length : null
      if (results.length >= limit || Buffer.byteLength(JSON.stringify(results)) >= budget) break
    }
    return fitRows(results, start, nextStart, budget, (results, nextStart) => ({ results, totalSize, nextStart }))
  }

  function checkView(result) {
    if (typeof result.value !== 'string' || result.representation !== 'view') fail('服务器未返回有效的 storage 校验结果')
    if (/<[^>]*\bclass\s*=\s*["'][^"']*\bfatal-render-error\b/i.test(result.value)) fail('服务器无法渲染 storage，请核对 XHTML 和宏参数')
  }
  async function validate(storage, id) {
    parseStorage(storage)
    const query = { contentIdContext: id }
    const body = { representation: 'storage', value: storage }
    if (!cloud) {
      try { checkView(await request(v1 + 'contentbody/convert/view', { method: 'POST', query, body })) }
      catch (e) { if (unavailable(e)) return 'local-xml'; throw e }
      return 'server-view'
    }
    const path = v1 + 'contentbody/convert/async/'
    const job = await request(path + 'view', { method: 'POST', query, body })
    const taskId = encodeURIComponent(required(job.asyncId, '异步校验 ID'))
    const until = Date.now() + 30000
    do {
      const result = await get(path + taskId)
      if (result.status === 'COMPLETED') { checkView(result); return 'cloud-view' }
      if (!['WORKING', 'TRANSFORMING', 'RERUNNING', 'RUNNING', 'PENDING'].includes(result.status)) fail('Cloud storage 校验失败：' + result.status)
      await delay(250)
    } while (Date.now() < until)
    fail('Cloud storage 校验尚未完成，请稍后预览')
  }
  async function convert(wiki, id) {
    if (cloud) return wikiStorage(wiki)
    const result = await request(v1 + 'contentbody/convert/storage', { method: 'POST', query: { contentIdContext: id }, body: { representation: 'wiki', value: wiki } })
    if (result.representation !== 'storage' || typeof result.value !== 'string') fail('服务器未返回有效的 wiki 转换结果')
    return result.value
  }

  async function save({ id, title, scope, parent, storage, version }) {
    const path = (cloud ? v2 + 'pages' : v1 + 'content') + (id ? '/' + id : '')
    const content = { representation: 'storage', value: storage }
    const body = cloud ? { id, title, status: 'current', spaceId: scope, parentId: parent, body: content, version } :
      { id, title, type: 'page', space: { key: scope }, ancestors: parent ? [{ id: parent }] : undefined, body: { storage: content }, version }
    const raw = await request(path, { method: id ? 'PUT' : 'POST', body })
    return { id: required(raw.id, '页面回执 ID'), title: raw.title, version: raw.version?.number }
  }

  async function movePlan(source, parentId) {
    const target = await page(parentId)
    if (source.scope !== target.scope) fail('不能跨空间移动')
    if (source.parent === target.id) fail('页面已在该父页之下')
    if (source.id === target.id) fail('页面不能移到自身')
    if (!cloud && target.ancestors.includes(source.id)) fail('目标父页是后代，会形成循环')
    if (cloud && target.parent) {
      const collections = { page: 'pages', folder: 'folders', whiteboard: 'whiteboards', database: 'databases', embed: 'embeds' }
      const seen = new Set()
      let node = { id: target.id, type: 'page' }
      while (node) {
        if (seen.has(node.id) || !Object.hasOwn(collections, node.type)) fail('无法核对目标祖先链')
        seen.add(node.id)
        const path = v2 + collections[node.type] + '/' + encodeURIComponent(node.id) + '/ancestors'
        const { results } = await get(path, { limit: 100 })
        if (results.some(n => n.id === source.id)) fail('目标父页是后代，会形成循环')
        node = results[0]
      }
    }
    return { id: source.id, version: source.version, from: source.parent, parent: target.id }
  }
  async function move(source, parent) {
    if (cloud) {
      await request(v1 + 'content/' + source.id + '/move/append/' + parent, { method: 'PUT' })
      return { id: source.id, parent }
    }
    return save({ ...source, parent, version: { number: source.version + 1, minorEdit: true } })
  }

  return { ...api, cloud, space, resolve, page, search, children, attachments, convert, validate, save, movePlan, move }
}
