function inline(text) {
  // Protect literal spans and link URLs from later emphasis substitutions.
  const parts = text.split(/(\{\{[^\n]*?\}\}|\[[^\]\n]+\]|![^!\n]+!)/g)
  return parts.map((part, i) => {
    if (!(i % 2)) return part.replace(/\*([^*\n]+)\*/g, '**$1**').replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,)])/g, '$1*$2*')
    if (part.startsWith('{{')) return '`' + part.slice(2, -2) + '`'
    if (part.startsWith('!')) {
      const name = part.slice(1, -1).split('|')[0]
      return '![图片](' + name + ')'
    }
    const [label, href] = part.slice(1, -1).split('|')
    if (href) return '[' + label + '](' + href + ')'
    if (label.startsWith('~') && label.length > 1) return '@' + label.slice(1)
    return /^(?:https?:\/\/|mailto:)/i.test(label) ? label : part
  }).join('')
}

const htmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
function decodeHtml(text) {
  return text.replace(/&(#x[\da-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, k) => {
    if (k.startsWith('#')) {
      const cp = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : Number(k.slice(1))
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return htmlEntities[k] ?? m
  })
}

function htmlMarkdown(source) {
  const clean = s => decodeHtml(s.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
  let text = source.replace(/\r\n/g, '\n').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, b) => '\n```\n' + decodeHtml(b.replace(/<[^>]+>/g, '')).trim() + '\n```\n')
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, b) => '`' + decodeHtml(b.replace(/<[^>]+>/g, '')) + '`')
  text = text.replace(/<img\b[^>]*>/gi, tag => {
    const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    const url = decodeHtml(src?.[1] ?? src?.[2] ?? '')
    return url ? `![${decodeHtml(alt?.[1] ?? alt?.[2] ?? '图片')}](${url})` : ''
  })
  text = text.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, h1, h2, body) => {
    const href = decodeHtml(h1 ?? h2 ?? ''), label = clean(body)
    return !label ? href : label === href ? href : `[${label}](${href})`
  })
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, b) => '\n' + '#'.repeat(Number(n)) + ' ' + clean(b) + '\n')
  text = text.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = Array.from(row.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi), m => clean(m[2]))
    return cells.length ? '\n| ' + cells.join(' | ') + ' |' : ''
  })
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, b) => '\n- ' + clean(b))
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|blockquote|ul|ol|table)>/gi, '\n\n')
  text = decodeHtml(text.replace(/<[^>]+>/g, ''))
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function wikiMarkdown(source) {
  if (source == null) return ''
  const outsideCode = source.replace(/\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/gi, '')
  if (/<(?:p|div|table|ul|ol|li|h[1-6]|br|img|pre|blockquote)\b[^>]*>|<a\b[^>]*\bhref=/i.test(outsideCode)) {
    return htmlMarkdown(source)
  }
  const blocks = source.split(/(\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\2\})/gi)
  const out = []
  for (let i = 0; i < blocks.length; i += 3) {
    const lines = blocks[i].split(/\r?\n/)
    out.push(lines.map(line => {
      const header = line.match(/^h([1-6])\.\s+(.*)/)
      if (header) return '#'.repeat(Number(header[1])) + ' ' + inline(header[2])
      const list = line.match(/^([*#]+)\s+(.+)/)
      if (list) return '  '.repeat(list[1].length - 1) + (list[1].endsWith('#') ? '1. ' : '- ') + inline(list[2])
      if (line.startsWith('||') && line.endsWith('||')) {
        const cells = line.slice(2, -2).split('||')
        return '| ' + cells.map(inline).join(' | ') + ' |\n| ' + cells.map(() => '---').join(' | ') + ' |'
      }
      return inline(line).replace(/^bq\. /, '> ')
    }).join('\n'))
    if (blocks[i + 1]) {
      const [, options = '', content] = blocks[i + 1].match(/^\{[^:}]+(?::([^}]*))?\}([\s\S]*?)\{[^}]+\}$/)
      const params = options.split('|').map(p => p.trim())
      const language = params.find(p => p.startsWith('language='))?.slice('language='.length).trim() ??
        params.find(p => p && !p.includes('=')) ?? ''
      const fence = '`'.repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), m => m[0].length + 1)))
      out.push('\n' + fence + language + '\n' + content.replace(/^\r?\n|\r?\n$/g, '') + '\n' + fence + '\n')
    }
  }
  return out.join('').trim()
}
