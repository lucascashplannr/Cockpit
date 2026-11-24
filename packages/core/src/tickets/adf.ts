/**
 * Jira's Atlassian Document Format, read as Markdown.
 *
 * Jira Cloud's v3 API hands descriptions and comments back as a tree, not as
 * text. The agent and the Ticket tool both want Markdown, and one direction is
 * all slice 1 needs: nothing here is ever written back.
 *
 * A node this does not know keeps its text: a ticket that reads a little flat
 * is better than one that loses a paragraph to a new node type.
 */

interface Node {
  type: string
  text?: string
  attrs?: Record<string, any>
  marks?: { type: string; attrs?: Record<string, any> }[]
  content?: Node[]
}

export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return typeof doc === 'string' ? doc : ''
  return blocks((doc as Node).content ?? [], '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Block nodes, one after the other, each followed by a blank line. */
function blocks(nodes: Node[], indent: string): string {
  return nodes.map((n) => block(n, indent)).filter((s) => s !== '').join('\n\n')
}

function block(n: Node, indent: string): string {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      return indent + inline(kids).replace(/\n/g, '\n' + indent)
    case 'heading':
      return indent + '#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1))) + ' ' + inline(kids)
    case 'bulletList':
      return list(kids, indent, () => '- ')
    case 'orderedList': {
      const start = Number(n.attrs?.order) || 1
      return list(kids, indent, (i) => start + i + '. ')
    }
    case 'taskList':
      return list(kids, indent, (_, item) => (item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] '))
    case 'decisionList':
      return list(kids, indent, () => '- Decision: ')
    case 'codeBlock': {
      const code = kids.map((k) => k.text ?? '').join('')
      const fence = code.includes('```') ? '~~~' : '```'
      return [indent + fence + (n.attrs?.language ?? ''), ...code.split('\n').map((l) => indent + l), indent + fence].join('\n')
    }
    case 'blockquote':
      return blocks(kids, '').split('\n').map((l) => indent + '> ' + l).join('\n')
    case 'panel': {
      const kind = String(n.attrs?.panelType ?? 'note')
      const body = blocks(kids, '').split('\n').map((l) => '> ' + l).join('\n')
      return indent + '> **' + kind[0]!.toUpperCase() + kind.slice(1) + '**\n' + body.replace(/^/gm, indent)
    }
    case 'rule':
      return indent + '---'
    case 'table':
      return table(kids, indent)
    case 'expand':
    case 'nestedExpand':
      return (n.attrs?.title ? indent + '**' + n.attrs.title + '**\n\n' : '') + blocks(kids, indent)
    case 'mediaSingle':
    case 'mediaGroup':
      return indent + kids.map(media).join(' ')
    case 'blockCard':
    case 'embedCard':
      return n.attrs?.url ? indent + '<' + n.attrs.url + '>' : ''
    default:
      // An inline node at block level, or a container this does not know.
      return kids.length && kids.every(isInline) ? indent + inline(kids) : kids.length ? blocks(kids, indent) : indent + inline([n])
  }
}

function list(items: Node[], indent: string, bullet: (i: number, item: Node) => string): string {
  return items
    .map((item, i) => {
      const b = bullet(i, item)
      const pad = indent + ' '.repeat(b.length)
      const kids = item.content ?? []
      // A task or decision item holds inline nodes directly; a list item holds blocks.
      if (kids.every(isInline)) return indent + b + inline(kids)
      // A list inside an item sits right under it: a blank line would make the list loose.
      const body = kids
        .map((k, j) => (j === 0 ? '' : LISTS.has(k.type) ? '\n' : '\n\n') + block(k, pad))
        .join('')
      return indent + b + body.slice(pad.length)
    })
    .join('\n')
}

function table(rows: Node[], indent: string): string {
  const cells = rows.map((r) => (r.content ?? []).map((c) => cellText(c)))
  if (!cells.length) return ''
  const width = Math.max(...cells.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const line = (r: string[]) => indent + '| ' + pad(r).join(' | ') + ' |'
  const headed = (rows[0]!.content ?? []).every((c) => c.type === 'tableHeader')
  const head = headed ? cells[0]! : Array(width).fill('')
  const body = headed ? cells.slice(1) : cells
  return [line(head), indent + '|' + ' --- |'.repeat(width), ...body.map(line)].join('\n')
}

/** A table cell on one line: Markdown tables have no room for more. */
function cellText(c: Node): string {
  return blocks(c.content ?? [], '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList', 'decisionList'])

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date', 'placeholder', 'mediaInline'])

function isInline(n: Node): boolean {
  return INLINE.has(n.type)
}

function inline(nodes: Node[]): string {
  return nodes.map(span).join('')
}

function span(n: Node): string {
  switch (n.type) {
    case 'text':
      return marked(n.text ?? '', n.marks ?? [])
    case 'hardBreak':
      return '\n'
    case 'mention':
      return '@' + String(n.attrs?.text ?? 'someone').replace(/^@/, '')
    case 'emoji':
      return n.attrs?.text ?? n.attrs?.shortName ?? ''
    case 'inlineCard':
      return n.attrs?.url ? '<' + n.attrs.url + '>' : ''
    case 'status':
      return '[' + (n.attrs?.text ?? '') + ']'
    case 'date': {
      const t = Number(n.attrs?.timestamp)
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
    }
    case 'mediaInline':
      return media(n)
    default:
      return n.content ? inline(n.content) : (n.text ?? '')
  }
}

function media(n: Node): string {
  const inner = n.type === 'media' || n.type === 'mediaInline' ? n : (n.content ?? []).find((k) => k.type === 'media')
  const name = inner?.attrs?.alt ?? inner?.attrs?.filename ?? 'attachment'
  return '[' + name + ']'
}

function marked(text: string, marks: { type: string; attrs?: Record<string, any> }[]): string {
  if (!text) return ''
  if (marks.some((m) => m.type === 'code')) {
    const tick = text.includes('`') ? '``' : '`'
    text = tick + text + tick
  } else {
    // Only the characters that would change how the line reads.
    text = text.replace(/([*_`\\])/g, '\\$1')
  }
  for (const m of marks) {
    if (m.type === 'strong') text = '**' + text + '**'
    else if (m.type === 'em') text = '*' + text + '*'
    else if (m.type === 'strike') text = '~~' + text + '~~'
  }
  const link = marks.find((m) => m.type === 'link')?.attrs?.href
  return link ? '[' + text + '](' + link + ')' : text
}
