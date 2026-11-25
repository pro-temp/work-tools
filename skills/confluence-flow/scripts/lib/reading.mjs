import { batch, choice, csv, fail, integer, partial, required } from './runtime.mjs'
import { analyze, storageWiki } from './storage.mjs'

const bytes = obj => Buffer.byteLength(JSON.stringify(obj)) + 1
const budgetError = () => fail('--max-bytes 容不下元信息或首个条目，请增大预算')
const boundary = (s, i) => i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]) ? i - 1 : i

function position(offset, length) {
  if (offset > length) fail('续读位置越界，请检查页面版本和坐标')
}

export function fitRows(rows, start, next, budget, make) {
  const count = rows.length
  function page(n) { return make(rows.slice(0, n), n === count ? next : start + n) }
  if (bytes(page(count)) <= budget) return page(count)
  let low = 0, high = count - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(page(mid)) <= budget) low = mid
    else high = mid - 1
  }
  if (!low || bytes(page(low)) > budget) budgetError()
  return page(low)
}

function fitText(source, start, end, budget, meta) {
  position(start, source.length)
  if (boundary(source, start) !== start) fail('offset 落在 Unicode 字符内部，请使用 nextOffset')
  function page(i) {
    const n = boundary(source, i)
    return { ...meta, offset: start, text: source.slice(start, n), nextOffset: n === source.length ? null : n }
  }
  if (end - start <= budget && bytes(page(end)) <= budget) return page(end)
  let low = start, high = Math.min(end - 1, start + budget)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(page(mid)) <= budget) low = mid
    else high = mid - 1
  }
  if (boundary(source, low) <= start) budgetError()
  return page(low)
}

export function matches(text, needle, sensitive) {
  const escape = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escape, sensitive ? 'gu' : 'giu')
  return text.matchAll(re)
}

function project(page, o, scan, budget) {
  const format = choice(o.format ?? 'wiki', ['wiki', 'storage', 'outline', 'full'], '--format')
  const meta = { id: page.id, title: page.title, version: page.version, format }
  const offset = integer(o.offset ?? 0, '--offset')
  if (o.grep !== undefined) {
    if (!['wiki', 'storage'].includes(format) || o.offset !== undefined || o.head !== undefined)
      fail('--grep 适用 wiki/storage，请用 --match-offset 续读')
    const text = format === 'storage' ? page.storage : storageWiki(page.storage)
    const hits = matches(text, required(o.grep, '--grep'), o['case-sensitive'])
    const context = integer(o.context ?? 32, '--context')
    const from = integer(o['match-offset'] ?? 0, '--match-offset')
    const rows = []
    let matchCount = 0, used = 0
    for (const m of hits) {
      if (matchCount++ < from || used >= budget || (scan && rows.length === 3)) continue
      const end = m.index + m[0].length
      const left = boundary(text, Math.max(0, m.index - context))
      const right = boundary(text, Math.min(text.length, end + context))
      const hit = { offset: m.index, end, text: text.slice(left, right) }
      rows.push(hit)
      used += bytes(hit)
    }
    position(from, matchCount)
    return fitRows(rows, from, from + rows.length < matchCount ? from + rows.length : null, budget,
      (matches, nextMatchOffset) => ({ ...meta, matchCount, matches, nextMatchOffset }))
  }
  if (o.context !== undefined || o['case-sensitive'] || o['match-offset'] !== undefined) fail('命中选项需要 --grep')
  const doc = format === 'outline' || format === 'full' ? analyze(page.storage) : undefined
  if (format === 'outline') {
    if (o.head !== undefined) fail('outline 请使用 --offset 翻页')
    const outline = [...doc.regions.map(r => ({ kind: 'region', ...r })), ...doc.sections.map(s => ({ kind: 'section', ...s }))]
    position(offset, outline.length)
    return fitRows(outline.slice(offset), offset, null, budget, (items, nextOffset) => ({ ...meta, items, nextOffset }))
  }
  const source = format === 'full' ? JSON.stringify({ ...page, ...doc }) : format === 'storage' ? page.storage : storageWiki(page.storage)
  if (scan) return fitText(source, 0, boundary(source, Math.min(source.length, 180)), budget, meta)
  let end = source.length
  if (o.head !== undefined) {
    const lines = integer(o.head, '--head', 1)
    end = offset
    for (let i = 0; i < lines && end < source.length; i++) {
      const eol = source.indexOf('\n', end)
      end = eol < 0 ? source.length : eol + 1
    }
  }
  return fitText(source, offset, end, budget, meta)
}

export async function readPages(api, o, scan) {
  if (Boolean(o.page) === Boolean(o.pages)) fail('请选择 --page 或 --pages')
  const budget = integer(o['max-bytes'] ?? 8192, '--max-bytes', 1)
  if (!o.pages) {
    if (o.start !== undefined || o.limit !== undefined) fail('单页请使用 --offset 或 --match-offset 翻页')
    return project(await api.page(await api.resolve(o.page), { body: true }), o, scan, budget)
  }
  const ids = [...new Set(csv(o.pages))]
  const start = integer(o.start ?? 0, '--start'), limit = integer(o.limit ?? 10, '--limit', 1)
  position(start, ids.length)
  const selected = ids.slice(start, start + limit)
  const make = (results, nextStart) => ({ results, total: ids.length, nextStart })
  const envelope = Math.max(bytes(make([], ids.length)), bytes(make([], null)))
  if (envelope >= budget) budgetError()
  const rows = []
  for (let i = 0; i < selected.length; i += 4) {
    const group = await batch(selected.slice(i, i + 4), async id =>
      project(await api.page(await api.resolve(id), { body: true }), o, scan, budget - envelope))
    rows.push(...group)
    if (bytes(make(rows, ids.length)) > budget) break
  }
  const next = start + rows.length
  const out = fitRows(rows, start, next < ids.length ? next : null, budget, make)
  return out.results.some(r => r.error) ? partial(out) : out
}
