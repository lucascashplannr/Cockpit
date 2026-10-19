<script setup lang="ts">
import { computed } from 'vue'
import { headingAnchor } from '@cockpit/shared'
import { createMarked, escapeHtml } from '../core/markdown.js'

/**
 * A markdown file as it reads, rather than as it is written.
 *
 * Opened from the Diff, so it is still a review: `changed` and `cut` are line
 * numbers of the new file, and a block that holds one is marked in the margin
 * — green where lines were added or rewritten, a red tick where lines were
 * taken out just before it. Rendered, a one-word fix in a long paragraph is
 * otherwise invisible, and the preview would be the one place in this panel
 * where you could not see what changed.
 *
 * Lexed once, rendered block by block: each top-level token is a block, and
 * its `raw` is exactly the source it came from, so counting newlines through
 * them gives every block its line range. Reference links are resolved by the
 * lexer over the whole file, so rendering the tokens one at a time loses none.
 */
const props = defineProps<{
  source: string
  changed?: ReadonlySet<number>
  cut?: ReadonlySet<number>
  /**
   * §9 — the docs reader's: the page a link names, or null when none does.
   * Without it a link has nowhere to go and is shown as the name it points at.
   */
  resolve?: (target: string) => { path: string; title: string } | null
}>()

const emit = defineEmits<{ open: [path: string, anchor: string | null] }>()

const md = createMarked({ breaks: false })

/** A link to a page, when the reader can follow it; a marked name otherwise. */
function pageLink(target: string, anchor: string | null, label: string | null): string {
  const hit = props.resolve?.(target) ?? null
  const shown = label ?? (hit && target ? hit.title : target.split('/').pop()!.replace(/\.md$/i, '')) + (anchor ? (target ? ' › ' : '') + anchor : '')
  if (!props.resolve) return '<span class="wiki" title="' + escapeHtml(target) + '">' + escapeHtml(shown) + '</span>'
  if (!hit) return '<span class="wiki broken" title="No page answers to ' + escapeHtml(target) + '">' + escapeHtml(shown) + '</span>'
  return (
    '<a class="wiki live" href="#" data-page="' + escapeHtml(hit.path) + '"' +
    (anchor ? ' data-anchor="' + escapeHtml(headingAnchor(anchor)) + '"' : '') +
    ' title="' + escapeHtml(hit.path + (anchor ? ' › ' + anchor : '')) + '">' + escapeHtml(shown) + '</a>'
  )
}

/**
 * `[[../frontend/naming]]`, `[[naming#Rules]]` and `[[naming|the naming rule]]`
 * — the vault's own links, resolved the way the docs resolve them.
 */
md.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src: string) => src.indexOf('[['),
      tokenizer(src: string) {
        const m = /^\[\[([^[\]|#\n]*)(?:#([^[\]|\n]+))?(?:\|([^[\]\n]+))?\]\]/.exec(src)
        if (!m) return undefined
        return { type: 'wikilink', raw: m[0], target: m[1]!.trim(), anchor: m[2]?.trim() ?? null, label: m[3]?.trim() ?? null }
      },
      renderer(t) {
        return pageLink(t.target as string, t.anchor as string | null, t.label as string | null)
      },
    },
  ],
  renderer: {
    // A relative `.md` link is a page too, in a reader that can follow it.
    link({ href, tokens }) {
      const m = /^(?!\w+:)([^#?]*\.(?:md|mdx|markdown))(?:#(.*))?$/i.exec(href)
      if (!props.resolve || !m) return false
      return pageLink(decodeURI(m[1]!), m[2] ? decodeURI(m[2]) : null, this.parser.parseInline(tokens))
    },
    // Anchors for `[[page#Heading]]` to land on.
    heading({ tokens, depth, text }) {
      if (!props.resolve) return false
      return '<h' + depth + ' data-anchor="' + escapeHtml(headingAnchor(text)) + '">' + this.parser.parseInline(tokens) + '</h' + depth + '>\n'
    },
  },
})

function onClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest<HTMLElement>('a.wiki.live')
  if (!a) return
  e.preventDefault()
  emit('open', a.dataset.page!, a.dataset.anchor ?? null)
}

/**
 * YAML frontmatter is metadata, not prose. Rendered as markdown it becomes a
 * rule and a run-on heading, so it is lifted out and shown as what it is. Flat
 * `key: value` lines become a table; anything nested is shown as written.
 */
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

type Front = { lines: number; rows: [string, string][] | null; raw: string }

const front = computed<Front | null>(() => {
  const m = FRONT.exec(props.source)
  if (!m) return null
  const body = m[1] ?? ''
  const rows: [string, string][] = []
  let flat = true
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) {
      flat = false
      break
    }
    rows.push([kv[1]!, kv[2]!.replace(/^(["'])(.*)\1$/, '$2')])
  }
  return { lines: m[0].split('\n').length - 1, rows: flat ? rows : null, raw: body }
})

type Block = { html: string; from: number; to: number }

const blocks = computed<Block[]>(() => {
  const f = front.value
  const src = f ? props.source.replace(FRONT, '') : props.source
  let line = f ? f.lines : 0
  let tokens
  try {
    tokens = md.lexer(src)
  } catch {
    return [{ html: md.parse(src, { async: false }) as string, from: 1, to: Infinity }]
  }
  const out: Block[] = []
  for (const t of tokens) {
    const breaks = t.raw.split('\n').length - 1
    if (t.type !== 'space' && t.type !== 'def' && t.raw.trim()) {
      const span = t.raw.replace(/\n+$/, '').split('\n').length
      out.push({ html: md.parser([t]) as string, from: line + 1, to: line + span })
    }
    line += breaks
  }
  return out
})

function holds(set: ReadonlySet<number> | undefined, b: Block, i: number): boolean {
  if (!set?.size) return false
  // A cut after the last block is still a cut, and it belongs to the last one.
  const last = i === blocks.value.length - 1
  for (const n of set) if (n >= b.from && (n <= b.to || last)) return true
  return false
}

/** Frontmatter lines count too: a changed `updated:` is a change. */
const frontChanged = computed(() => {
  const f = front.value
  if (!f || !props.changed) return false
  for (const n of props.changed) if (n <= f.lines) return true
  return false
})
</script>

<template>
  <article class="mdp selectable" @click="onClick">
    <div v-if="front" class="front" :class="{ chg: frontChanged }">
      <dl v-if="front.rows">
        <template v-for="[k, v] in front.rows" :key="k">
          <dt>{{ k }}</dt>
          <dd class="mono">{{ v }}</dd>
        </template>
      </dl>
      <pre v-else class="mono">{{ front.raw }}</pre>
    </div>
    <div
      v-for="(b, i) in blocks"
      :key="i"
      class="blk"
      :class="{ chg: holds(changed, b, i), cut: holds(cut, b, i) }"
      v-html="b.html"
    />
    <p v-if="!blocks.length && !front" class="nothing">This file is empty.</p>
  </article>
</template>

<style scoped>
/* A document, not a transcript: the full text colour, headings with real
   steps, and the same 780px measure the conversation reads at. */
.mdp {
  max-width: 780px;
  margin: 0 auto;
  padding: 22px 32px 48px;
  font-size: var(--fs-md, 14px);
  line-height: 1.65;
  color: var(--text);
  word-break: break-word;
}

/* The change marks sit in the gutter left of the measure, so the text itself
   never moves between Code and Preview or between a marked block and not. */
.blk, .front { position: relative; }
.blk.chg::before, .front.chg::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 2px;
  bottom: 2px;
  width: 3px;
  border-radius: 2px;
  background: var(--ok);
  opacity: 0.8;
}
.blk.cut::after {
  content: '';
  position: absolute;
  left: -19px;
  top: -4px;
  width: 9px;
  height: 2px;
  border-radius: 1px;
  background: var(--danger);
}

.front {
  margin: 0 0 22px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
}
.front dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 16px;
  margin: 0;
}
.front dt { color: var(--text-dim); }
.front dd { margin: 0; color: var(--text-muted); overflow-wrap: anywhere; }
.front pre { margin: 0; white-space: pre-wrap; color: var(--text-muted); }

.mdp :deep(.blk > *:first-child) { margin-top: 0; }
.mdp :deep(p) { margin: 0 0 14px; }
.mdp :deep(h1), .mdp :deep(h2), .mdp :deep(h3), .mdp :deep(h4), .mdp :deep(h5), .mdp :deep(h6) {
  margin: 26px 0 10px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text);
}
.mdp :deep(h1) { font-size: 22px; }
.mdp :deep(h2) { font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.mdp :deep(h3) { font-size: 15px; }
.mdp :deep(h4), .mdp :deep(h5), .mdp :deep(h6) { font-size: 14px; color: var(--text-muted); }
.mdp :deep(ul), .mdp :deep(ol) { margin: 0 0 14px; padding-left: 24px; }
.mdp :deep(li) { margin: 3px 0; }
.mdp :deep(li > p) { margin: 0 0 6px; }
.mdp :deep(li::marker) { color: var(--text-dim); }
.mdp :deep(input[type='checkbox']) { margin: 0 6px 0 -18px; vertical-align: -1px; }
.mdp :deep(strong) { font-weight: 640; }
.mdp :deep(a) { color: var(--accent); text-decoration: none; }
.mdp :deep(a:hover) { text-decoration: underline; }
.mdp :deep(.wiki) {
  color: var(--accent);
  border-bottom: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  cursor: default;
}
.mdp :deep(a.wiki.live) { cursor: pointer; border-bottom-style: solid; }
.mdp :deep(a.wiki.live:hover) { text-decoration: none; border-bottom-color: var(--accent); }
.mdp :deep(.wiki.broken) { color: var(--warn); border-bottom-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.mdp :deep(blockquote) {
  margin: 0 0 14px;
  padding: 4px 0 4px 14px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-muted);
}
.mdp :deep(blockquote > p:last-child) { margin-bottom: 0; }
.mdp :deep(hr) { border: none; border-top: 1px solid var(--line); margin: 22px 0; }

.mdp :deep(code.cm-inline) {
  font-family: var(--mono);
  font-size: 0.88em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover);
}
.mdp :deep(pre.cm-code) {
  margin: 0 0 14px;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  overflow-x: auto;
}
.mdp :deep(pre.cm-code code) {
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.55;
  white-space: pre;
}
.mdp :deep(pre.cm-code[data-lang])::before {
  content: attr(data-lang);
  display: block;
  margin: -3px 0 6px;
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
/* A wide table scrolls inside its own box rather than pushing the page. */
.mdp :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 0 0 14px;
  font-size: var(--fs-sm);
}
/* Words stay whole in a cell: the page's own `break-word` would let the table
   shrink a column to a few letters rather than scroll. */
.mdp :deep(th), .mdp :deep(td) {
  border: 1px solid var(--line);
  padding: 5px 10px;
  text-align: left;
  vertical-align: top;
  word-break: normal;
  overflow-wrap: normal;
}
.mdp :deep(th) { background: var(--bg-sunken); font-weight: 600; }

.nothing { color: var(--text-dim); font-size: var(--fs-sm); }
</style>
