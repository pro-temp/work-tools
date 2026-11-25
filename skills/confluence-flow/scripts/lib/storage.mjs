import { fail } from './runtime.mjs'

const named = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"', nbsp: '\u00a0', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '\u00ab', raquo: '\u00bb', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•' }

export function decode(text) {
  return text.replace(/&(#x[\da-fA-F]+|#\d+|[A-Za-z][\w.-]*);|&/g, (all, name) => {
    if (!name) fail('XHTML 的 & 必须写成实体 &amp;')
    if (!name.startsWith('#')) return Object.hasOwn(named, name) ? named[name] : all
    const value = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    if (!(value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 0xd7ff) ||
      (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff))) fail('无效的 XML 字符实体')
    return String.fromCodePoint(value)
  })
}

const xmlName = '[A-Za-z_][\\w.:-]*'
export function parseStorage(source) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(source)) fail('XHTML 包含无效的 XML 字符')
  const root = { name: '#root', children: [], start: 0, openEnd: 0, closeStart: source.length, end: source.length }
  const stack = [root]
  const opening = new RegExp('<(' + xmlName + ')', 'y')
  const ending = new RegExp('</(' + xmlName + ')\\s*>', 'y')
  const attribute = new RegExp('\\s+(' + xmlName + ')\\s*=\\s*(?:"([^"<]*)"|\\x27([^\\x27<]*)\\x27)', 'y')
  const close = /\s*(\/?)>/y
  let at = 0
  while (at < source.length) {
    const parent = stack.at(-1)
    if (source[at] !== '<') {
      const next = source.indexOf('<', at)
      const end = next < 0 ? source.length : next
      const value = source.slice(at, end)
      if (value.includes(']]>')) fail('XHTML 普通文本包含 CDATA 结束符')
      parent.children.push({ name: '#text', value: decode(value) })
      at = end
      continue
    }
    if (source.startsWith('<![CDATA[', at) || source.startsWith('<!--', at) || source.startsWith('<?', at)) {
      const cdata = source.startsWith('<![CDATA[', at)
      const terminator = cdata ? ']]>' : source.startsWith('<!--', at) ? '-->' : '?>'
      const end = source.indexOf(terminator, at + (cdata ? 9 : terminator === '-->' ? 4 : 2))
      if (end < 0) fail('XHTML 注释、CDATA 或处理指令没有结束')
      if (cdata) parent.children.push({ name: '#text', value: source.slice(at + 9, end) })
      at = end + terminator.length
      continue
    }
    if (source.startsWith('</', at)) {
      ending.lastIndex = at
      const match = ending.exec(source)
      if (!match || stack.length === 1 || match[1] !== parent.name) fail('XHTML 结束标签不匹配，位置 ' + at)
      parent.closeStart = at
      at = parent.end = ending.lastIndex
      stack.pop()
      continue
    }
    opening.lastIndex = at
    const match = opening.exec(source)
    if (!match) fail('无效或不支持的 XHTML 标记，位置 ' + at)
    const node = { name: match[1], attrs: Object.create(null), start: at, children: [] }
    at = opening.lastIndex
    for (;;) {
      attribute.lastIndex = at
      const attr = attribute.exec(source)
      if (!attr) break
      if (attr[1] in node.attrs) fail('XHTML 属性重复：' + attr[1])
      node.attrs[attr[1]] = decode(attr[2] ?? attr[3])
      at = attribute.lastIndex
    }
    close.lastIndex = at
    const finish = close.exec(source)
    if (!finish) fail('XHTML 属性或起始标签无效，位置 ' + at)
    at = node.openEnd = close.lastIndex
    parent.children.push(node)
    if (finish[1]) node.end = node.closeStart = at
    else stack.push(node)
  }
  if (stack.length > 1) fail('XHTML 标签没有关闭：' + stack.at(-1).name)
  return root
}

const plain = n => n.name === '#text' ? n.value : n.children.map(plain).join('')
const isMacro = n => n.name === 'ac:structured-macro' || n.name === 'ac:macro'
const macrosWithBody = ['info', 'note', 'warning', 'tip', 'panel', 'expand', 'section', 'column']
function render(node, list = '') {
  if (node.name === '#text') return node.value
  const { name, children, attrs } = node
  const inner = () => children.map(c => render(c, list)).join('')
  if (isMacro(node)) {
    const kind = attrs['ac:name']
    const params = children.filter(c => c.name === 'ac:parameter')
      .map(c => (c.attrs['ac:name'] ? c.attrs['ac:name'] + '=' : '') + plain(c))
    const marker = '{' + kind + (params.length ? ':' + params.join('|') : '') + '}'
    if (['jira', 'toc', 'anchor'].includes(kind)) return marker
    const body = children.find(c => c.name === 'ac:rich-text-body' || c.name === 'ac:plain-text-body')
    if (['code', 'noformat', ...macrosWithBody].includes(kind)) {
      const content = body ? (kind === 'code' || kind === 'noformat' ? plain(body) : render(body).trim()) : ''
      return '\n' + marker + '\n' + content + '\n{' + kind + '}\n'
    }
    return '\n[宏 ' + kind + '，详见 storage]' + (body ? render(body) : '') + '\n'
  }
  if (/^h[1-6]$/.test(name)) return '\n' + name + '. ' + inner().trim() + '\n'
  if (['p', 'div', 'blockquote', 'ac:layout-cell'].includes(name)) return '\n' + inner() + '\n'
  if (name === 'br') return '\\\\'
  if (name === 'hr') return '\n----\n'
  const marks = { strong: '*', b: '*', i: '_', em: '_', del: '-', s: '-', u: '+' }
  if (Object.hasOwn(marks, name)) return marks[name] + inner() + marks[name]
  if (name === 'code') return '{{' + plain(node) + '}}'
  if (name === 'pre') return '\n{noformat}\n' + plain(node) + '\n{noformat}\n'
  if (name === 'ul' || name === 'ol') return '\n' + children.map(c => render(c, list + (name === 'ul' ? '*' : '#'))).join('')
  if (name === 'li') return list + ' ' + inner().trim() + '\n'
  if (name === 'tr') {
    const cells = children.filter(c => c.name === 'td' || c.name === 'th')
    if (!cells.length) return ''
    return cells.map(c => (c.name === 'th' ? '||' : '|') + render(c).trim().replace(/\n+/g, ' ')).join('') +
      (cells.at(-1).name === 'th' ? '||' : '|') + '\n'
  }
  if (name === 'a') return attrs.href ? '[' + inner() + '|' + attrs.href + ']' : inner()
  if (name === 'ac:image' || name === 'ac:link') {
    const ref = children.find(c => c.name.startsWith('ri:'))
    const anchor = attrs['ac:anchor']
    const label = children.find(c => c.name.endsWith('link-body'))
    let dest = ''
    if (ref?.name === 'ri:attachment') dest = (name === 'ac:image' ? '' : '^') + ref.attrs['ri:filename']
    if (ref?.name === 'ri:url') dest = ref.attrs['ri:value']
    if (ref?.name === 'ri:page') dest = (ref.attrs['ri:space-key'] ? ref.attrs['ri:space-key'] + ':' : '') + ref.attrs['ri:content-title']
    if (ref?.name === 'ri:user') return '[~' + (ref.attrs['ri:account-id'] || ref.attrs['ri:userkey'] || ref.attrs['ri:username']) + ']'
    if (anchor) dest += '#' + anchor
    return name === 'ac:image' ? '!' + dest + '!' : '[' + (label ? plain(label) + '|' : '') + dest + ']'
  }
  return inner()
}

export function storageWiki(source) { return render(parseStorage(source)).trim() }

export function analyze(source) {
  const root = parseStorage(source)
  // Only actual layout containers may introduce an editable region. A heading inside a macro is opaque.
  const cells = []
  function containers(node) {
    if (node.name === 'ac:layout-cell' || (isMacro(node) && node.attrs['ac:name'] === 'column')) {
      const cell = isMacro(node) ? node.children.find(c => c.name === 'ac:rich-text-body') : node
      if (cell) cells.push(cell)
    } else if (['#root', 'ac:layout', 'ac:layout-section', 'ac:rich-text-body'].includes(node.name) ||
               (isMacro(node) && node.attrs['ac:name'] === 'section')) node.children.forEach(containers)
  }
  // Root-level text can also precede, follow, or separate layouts. Stop each
  // such region at the layout boundary so replacing it cannot consume a cell.
  let firstChild = 0, start = 0
  function rootRegion(lastChild, end) {
    if (source.slice(start, end).trim()) cells.push({ name: '#root', children: root.children.slice(firstChild, lastChild), openEnd: start, closeStart: end })
  }
  for (const [i, n] of root.children.entries()) {
    if (n.name !== 'ac:layout' && !(isMacro(n) && ['section', 'column'].includes(n.attrs['ac:name']))) continue
    rootRegion(i, n.start)
    containers(n)
    firstChild = i + 1
    start = n.end
  }
  if (firstChild) rootRegion(root.children.length, source.length)
  else cells.push(root)
  const sections = []
  const regions = cells.map((cell, idx) => {
    const id = 'r' + (idx + 1)
    const headings = cell.children.filter(n => /^h[1-6]$/.test(n.name))
    const open = []
    for (const [i, h] of headings.entries()) {
      const level = Number(h.name[1])
      while (open.length && open.at(-1).level >= level) open.pop().end = h.start
      const entry = { id: id + '-s' + (i + 1), region: id, title: plain(h).trim(), level,
        start: h.start, bodyStart: h.end, end: cell.closeStart }
      sections.push(entry)
      open.push(entry)
    }
    const body = render(cell).trim()
    return { id, start: cell.openEnd, end: cell.closeStart, editable: cell.name === '#root' || cell.end !== cell.openEnd,
      tocOnly: /^\{toc(?::[^}]*)?\}$/.test(body) }
  })
  return { wiki: render(root).trim(), regions, sections }
}

export function editStorage(source, replacement, mode, section, region) {
  if (mode === 'replace') return replacement
  parseStorage(replacement)
  const { regions, sections } = analyze(source)
  const candidates = region ? regions.filter(r => r.id === region) : regions
  if (!candidates.length) fail('找不到区域 ' + region)
  let start, end
  if (mode === 'append') {
    const target = candidates.length === 1 ? candidates : candidates.filter(r => !r.tocOnly)
    if (target.length !== 1 || !target[0].editable) fail('请用 outline 选择唯一可编辑的 --region')
    start = end = target[0].end
  } else {
    const matches = sections.filter(s => (!region || s.region === region) && (s.id === section || s.title === section))
    if (matches.length !== 1) fail('章节未唯一匹配，请用 outline 选择 --section ID')
    start = matches[0].bodyStart
    end = matches[0].end
  }
  return source.slice(0, start) + replacement + source.slice(end)
}

export function layout(source, style) {
  if (style === 'plain') return source
  const root = parseStorage(source)
  function nested(n) {
    return n.name === 'ac:layout' || (isMacro(n) && ['section', 'column'].includes(n.attrs['ac:name'])) ||
      (n.name !== '#text' && n.children.some(nested))
  }
  if (nested(root)) fail('正文已含布局，请使用 plain')
  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar"><ac:layout-cell>' + source +
    '</ac:layout-cell><ac:layout-cell><ac:structured-macro ac:name="toc" ac:schema-version="1"/></ac:layout-cell></ac:layout-section></ac:layout>'
}

const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const cdata = s => '<![CDATA[' + s.replaceAll(']]>', ']]]]><![CDATA[>') + ']]>'

function macro(kind, args, body = '') {
  const params = args ? args.split('|').map((pair, i) => {
    const eq = pair.indexOf('=')
    const key = eq < 0 ? (i === 0 && kind === 'jira' ? 'key' : kind === 'code' ? 'language' : '') : pair.slice(0, eq)
    return '<ac:parameter ac:name="' + xml(key) + '">' + xml(eq < 0 ? pair : pair.slice(eq + 1)) + '</ac:parameter>'
  }).join('') : ''
  return '<ac:structured-macro ac:name="' + kind + '" ac:schema-version="1">' + params + body + '</ac:structured-macro>'
}

function wikiInline(text) {
  const tokens = /(\{\{[^}]*\}\}|\{(?:jira|toc|anchor)(?::[^}]*)?\}|\[[^\]\n]+\]|![^!\n]+!|\*[^*\n]+\*|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_])|\\\\)/gu
  return text.split(tokens).map((s, i) => {
    if (!(i % 2)) {
      if (/\{[a-z][\w-]*(?::[^}]+)?\}/i.test(s)) fail('本地转换不支持该 Wiki 宏，请提供 --storage-file')
      return xml(s)
    }
    if (s.startsWith('{{')) return '<code>' + xml(s.slice(2, -2)) + '</code>'
    if (s[0] === '{') {
      const [, kind, args] = s.match(/^\{(\w+)(?::([^}]*))?\}$/)
      return macro(kind, args)
    }
    if (s[0] === '!') {
      const [file, props] = s.slice(1, -1).split('|')
      if (props) fail('带属性的图片请使用 --storage-file')
      const ref = /^https?:\/\//i.test(file) ? '<ri:url ri:value="' : '<ri:attachment ri:filename="'
      return '<ac:image>' + ref + xml(file) + '"/></ac:image>'
    }
    if (s[0] === '[') {
      const [label, target = label] = s.slice(1, -1).split('|')
      if (/^(https?:\/\/|mailto:)/i.test(target)) return '<a href="' + xml(target) + '">' + xml(label) + '</a>'
      if (target.startsWith('~')) fail('用户提及请用带用户标识的 --storage-file')
      const [page, anchor] = target.split('#')
      const colon = page.indexOf(':')
      const ref = !page ? '' : page.startsWith('^') ? '<ri:attachment ri:filename="' + xml(page.slice(1)) + '"/>' :
        '<ri:page ri:content-title="' + xml(page.slice(colon + 1)) + '"' + (colon < 0 ? '' : ' ri:space-key="' + xml(page.slice(0, colon)) + '"') + '/>'
      return '<ac:link' + (anchor ? ' ac:anchor="' + xml(anchor) + '"' : '') + '>' + ref +
        (label === target ? '' : '<ac:plain-text-link-body>' + cdata(label) + '</ac:plain-text-link-body>') + '</ac:link>'
    }
    if (s === '\\\\') return '<br/>'
    const tag = s[0] === '*' ? 'strong' : 'em'
    return '<' + tag + '>' + xml(s.slice(1, -1)) + '</' + tag + '>'
  }).join('')
}

// Cloud has no wiki-to-storage converter. Handle the documented subset and preserve literal code.
export function wikiStorage(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  function readBlock(stop) {
    let output = ''
    while (i < lines.length) {
      const line = lines[i++]
      if (stop && line.trim() === '{' + stop + '}') return output
      if (!line.trim()) continue
      const block = line.trim().match(/^\{(code|noformat|info|note|warning|tip|panel|expand|section|column)(?::([^}]*))?\}$/)
      if (block) {
        const [, kind, args] = block
        let body
        if (kind === 'code' || kind === 'noformat') {
          const from = i
          while (i < lines.length && lines[i].trim() !== '{' + kind + '}') i++
          if (i === lines.length) fail('Wiki 宏没有结束：' + kind)
          body = '<ac:plain-text-body>' + cdata(lines.slice(from, i++).join('\n')) + '</ac:plain-text-body>'
        } else body = '<ac:rich-text-body>' + readBlock(kind) + '</ac:rich-text-body>'
        output += macro(kind, args, body)
      } else if (/^h[1-6]\.\s/.test(line)) {
        const tag = line.slice(0, 2)
        output += '<' + tag + '>' + wikiInline(line.slice(3).trimStart()) + '</' + tag + '>'
      } else if (/^\|/.test(line)) {
        const rows = [line]
        while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++])
        output += '<table><tbody>' + rows.map(row => {
          const cells = []
          const tokens = /(\|\|?)([^]*?)(?=\|\|?|$)/gy
          // Mask pipes inside links, macro parameters and escaped cell text before splitting.
          const literals = []
          const masked = row.replace(/\[[^\]]*\]|\{[^}]*\}|\\\|/g, val => '\x00' + (literals.push(val) - 1) + '\x00')
          for (const m of masked.matchAll(tokens)) {
            if (m.index + m[0].length === masked.length && !m[2]) break
            const tag = m[1] === '||' ? 'th' : 'td'
            const value = m[2].replace(/\x00(\d+)\x00/g, (_, n) => literals[n].replace(/\\\|/g, '|'))
            cells.push('<' + tag + '>' + wikiInline(value) + '</' + tag + '>')
          }
          return '<tr>' + cells.join('') + '</tr>'
        }).join('') + '</tbody></table>'
      } else if (/^[*#]+\s+/.test(line)) {
        const list = [line]
        while (i < lines.length && /^[*#]+\s+/.test(lines[i])) list.push(lines[i++])
        let prev = ''
        const tag = ch => ch === '*' ? 'ul' : 'ol'
        for (const entry of list) {
          const [, marks, value] = entry.match(/^([*#]+)\s+(.+)$/)
          let common = 0
          while (common < marks.length && marks[common] === prev[common]) common++
          for (let j = prev.length - 1; j >= common; j--) output += '</li></' + tag(prev[j]) + '>'
          if (common === marks.length) output += '</li><li>'
          for (let j = common; j < marks.length; j++) output += '<' + tag(marks[j]) + '><li>'
          output += wikiInline(value)
          prev = marks
        }
        for (const ch of [...prev].reverse()) output += '</li></' + tag(ch) + '>'
      } else if (line === '----') output += '<hr/>'
      else output += '<p>' + wikiInline(line) + '</p>'
    }
    if (stop) fail('Wiki 宏没有结束：' + stop)
    return output
  }
  return readBlock()
}
