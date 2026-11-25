import { createHash } from 'node:crypto'
import { fail, partial, required } from './runtime.mjs'

async function tree(api, id, keepRoot) {
  const root = await api.page(id, { operations: true })
  const home = String(required((await api.space(root.scope, api.cloud)).homepage, '空间首页 ID（无法核实时不能删除）'))
  if (!/^\d+$/.test(home)) fail('空间首页 ID 无效')
  const queue = [{ id, parent: root.parent, depth: 0 }]
  const seen = new Set([id])
  const pages = []
  for (const entry of queue) {
    const n = entry.depth ? await api.page(entry.id, { operations: true }) : root
    if (n.scope !== root.scope || n.parent !== entry.parent) fail('页面树在读取时发生变化')
    if (!keepRoot || entry.depth) {
      if (n.id === home) fail('禁止删除空间首页')
      if (n.canDelete === false) fail('缺少页面删除权限：' + n.title)
      pages.push({ ...entry, title: n.title, version: n.version })
    }
    for await (const { rows } of api.children(n.id)) {
      for (const child of rows) {
        if (child.type && child.type !== 'page') fail('子树包含非页面内容，请单独核对：' + child.title)
        const childId = String(child.id)
        if (!/^\d+$/.test(childId)) fail('子页面 ID 无效')
        if (seen.has(childId)) fail('页面树含有重复节点')
        seen.add(childId)
        if (seen.size > 100 + Number(keepRoot)) fail('受影响页面超过 100 页，请缩小范围')
        queue.push({ id: childId, parent: n.id, depth: entry.depth + 1 })
      }
    }
  }
  pages.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id))
  const summary = { root: { id, title: root.title, version: root.version, parent: root.parent, space: root.scope },
    keepRoot, count: pages.length, pages }
  const treeHash = createHash('sha256').update(JSON.stringify([api.profile.baseUrl, summary])).digest('hex')
  return { ...summary, treeHash }
}

export async function trash(api, id, o) {
  const plan = await tree(api, id, Boolean(o['keep-root']))
  if (!o.apply) return { preview: true, ...plan }
  if (o['confirm-title'] !== plan.root.title) fail('--confirm-title 必须与根页标题完全一致')
  const expected = required(o['expected-tree'], '--expected-tree（使用已确认预览的 treeHash）')
  if (expected !== plan.treeHash) fail('执行前复查发现页面树或版本与已确认的预览不同，请重新预览')
  const trashed = []
  for (const node of plan.pages) {
    try {
      const latest = await api.page(node.id)
      if (latest.version !== node.version || latest.parent !== node.parent || latest.scope !== plan.root.space || latest.title !== node.title)
        fail('页面版本或位置已变化')
      for await (const { rows } of api.children(node.id)) if (rows.length) fail('页面仍有子内容，请重新预览')
      const endpoint = api.cloud ? 'api/v2/pages/' : 'rest/api/content/'
      await api.request(endpoint + node.id, { method: 'DELETE', query: api.cloud ? { purge: false } : { status: 'current' } })
      trashed.push(node.id)
    } catch (e) {
      return partial({ root: plan.root, trashed, stoppedAt: node.id, error: e.message, remaining: plan.pages.slice(trashed.length + 1).map(n => n.id) })
    }
  }
  return { root: plan.root, trashed }
}

export async function restore(api, id, parent, apply) {
  const page = await api.page(id, { status: 'trashed' })
  if (parent) {
    const target = await api.page(parent)
    if (target.scope !== page.scope || target.id === page.id) fail('恢复位置须是同空间的有效父页')
  }
  if (!apply) return { preview: true, id, title: page.title, version: page.version, parent }
  await api.request('rest/api/content/' + id, { method: 'PUT', query: api.cloud ? {} : { status: 'trashed' },
    body: { id, type: 'page', title: page.title, status: 'current', version: { number: page.version + 1 } } })
  if (parent) {
    try {
      const current = await api.page(id, { body: !api.cloud })
      if (current.parent !== parent) {
        await api.movePlan(current, parent)
        await api.move(current, parent)
      }
    } catch (e) { return partial({ restored: true, id, error: e.message, next: '页面已恢复，请核对后使用 move 调整父页' }) }
  }
  return { restored: true, id, parent }
}
