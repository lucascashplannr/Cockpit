<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Marked } from 'marked'

/**
 * What the engine wrote, as it meant it to read.
 *
 * The transcript used to be `white-space: pre-wrap` on a bare span, so every
 * heading, list and fenced block arrived as its own literal syntax — the one
 * place in the app where what is on screen was the source rather than the
 * result. A model writes markdown whether or not anyone renders it.
 *
 * Raw HTML never reaches the DOM. The renderer below emits only the tags it
 * writes itself and escapes everything else, so a model that produces a
 * `<script>` — or is talked into producing one by a file it just read — yields
 * visible text rather than an execution. `v-html` in a renderer with
 * `nodeIntegration: false` is still a renderer, and this is the one surface in
 * the app whose content nobody wrote by hand.
 *
 * `live` is the same message while it is still being written: the text is
 * paced by `usePaced` before it gets here, and this adds the two things that
 * only make sense mid-sentence — a soft leading edge, and the caret at the end
 * of it. Nothing about the finished render changes, so the durable event
 * replacing the draft still lands without a flicker.
 */
const props = defineProps<{ text: string; live?: boolean }>()

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Only `http(s)` and `mailto`. A `javascript:` href is the other half of the
 * hole the escaping above closes.
 */
function safeHref(href: string): string | null {
  try {
    const u = new URL(href, 'https://x.invalid')
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? href : null
  } catch {
    return null
  }
}

const md = new Marked({ gfm: true, breaks: true })

md.use({
  renderer: {
    // Raw HTML in, escaped text out — in both block and inline position.
    html({ raw }: { raw: string }) {
      return escape(raw)
    },
    code({ text, lang }: { text: string; lang?: string }) {
      const l = (lang ?? '').split(/\s+/)[0] ?? ''
      return (
        '<pre class="cm-code"' + (l ? ' data-lang="' + escape(l) + '"' : '') +
        '><code>' + escape(text) + '</code></pre>'
      )
    },
    codespan({ text }: { text: string }) {
      return '<code class="cm-inline">' + escape(text) + '</code>'
    },
    link({ href, text }: { href: string; text: string }) {
      const safe = safeHref(href)
      if (!safe) return escape(text)
      // §2 — the window is not a browser: a link leaves it, and never
      // navigates the app away from itself.
      return '<a href="' + escape(safe) + '" target="_blank" rel="noreferrer noopener">' + text + '</a>'
    },
    image({ text }: { text: string }) {
      return escape(text)
    },
  },
})

/**
 * Half of a marker is not emphasis yet.
 *
 * A stream hands over `**` before the word inside it, so a paragraph being
 * written shows its own syntax and then swallows it: `**loader` sits on screen
 * for the length of a word and becomes **loader**. Two markers are held back —
 * a run at the very end, and an opener whose partner has not arrived yet.
 *
 * What is hidden is the marker, never the word. Waiting for the closing pair
 * before showing anything would hold real text back for as long as the phrase
 * takes to write; showing plain text that turns bold a moment later costs a
 * hair of width and reads as nothing at all.
 *
 * Never a run of three or more: that is a fence or a rule. This is only ever
 * applied to the block being written, and never to a fenced one, where every
 * one of these characters is content.
 */
const PAIRS = ['**', '~~', '`']

function hush(src: string): string {
  let out = src
  const m = /([*_~`])\1*$/.exec(out)
  if (m && m[0].length <= 2) {
    const cut = out.slice(0, -m[0].length)
    if (cut.trim()) out = cut
  }
  for (const mark of PAIRS) {
    if ((out.split(mark).length - 1) % 2 === 0) continue
    const i = out.lastIndexOf(mark)
    out = out.slice(0, i) + out.slice(i + mark.length)
  }
  return out.trim() ? out : src
}

/**
 * The message, cut at its own seams.
 *
 * One `v-html` for the whole message means every finished paragraph is thrown
 * away and re-parsed on every frame of the stream, which is both the cost and
 * the reason nothing in it can ever animate: no node survives long enough to.
 * Cut into top-level blocks, the tail is the only thing that churns — the rest
 * is untouched DOM, and a block that appears is a real mount that can be given
 * an entrance.
 *
 * `def` sends it back to one piece: a link reference at the bottom of a
 * message is resolved against the whole document, and per-block parsing would
 * drop the href.
 */
const cache = new Map<string, string>()

function parse(src: string): string {
  const hit = cache.get(src)
  if (hit !== undefined) return hit
  const html = md.parse(src, { async: false }) as string
  // A stream re-parses the growing tail once a frame; this keeps the finished
  // blocks free without holding a whole session's prose.
  if (cache.size > 400) cache.clear()
  cache.set(src, html)
  return html
}

const blocks = computed<string[]>(() => {
  const src = props.text ?? ''
  if (!src) return []
  let tokens
  try {
    tokens = md.lexer(src)
  } catch {
    return [parse(src)]
  }
  if (tokens.some((t) => t.type === 'def')) return [parse(src)]
  const keep = tokens.filter((t) => t.type !== 'space' && t.raw.trim())
  return keep.map((t, i) => {
    // Only the block still being written, and only if it is prose: inside a
    // fence every marker is content, and lexing first is what tells the two
    // apart — a trailing ``` is a code block opening, not an unpaired marker.
    const half = props.live && i === keep.length - 1 && t.type !== 'code'
    return parse(half ? hush(t.raw) : t.raw)
  })
})

/* ── the leading edge ─────────────────────────────────────────────────────
 *
 * Each word comes in on its own clock: it arrives at nothing and is fully lit
 * about a third of a second later, so what you read is ink landing rather than
 * text switching on. Two things this deliberately is not:
 *
 * It is not a ramp over the last N characters. That measures age in characters
 * arrived rather than in time, so a pause in the stream froze half a sentence
 * at a quarter opacity and a burst lit it in one frame — and its groups fell
 * mid-word, which is what read as broken: the middle of a word dimmer than its
 * end is not unfinished text, it is damaged text.
 *
 * It is not a CSS animation either, because nothing here survives a frame: the
 * block is re-rendered from markdown as the text grows, so an animation would
 * restart under every word on every frame. The opacity is a pure function of
 * how long ago that word arrived, so it only ever increases — recomputed each
 * frame, it *is* the animation.
 *
 * The wrapping is done to the DOM rather than to the markdown on purpose: the
 * source is escaped, so a span written into it would arrive on screen as one.
 */
const root = ref<HTMLElement | null>(null)
/** How long a word takes to come fully in. */
const FADE = 380
/** Only the head of the message is ever mid-fade; this bounds the work. */
const MAX_WORDS = 60
const SPACE = /\s/

function reduced(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * When each character of the source became visible.
 *
 * The prop only ever grows by whole words (`usePaced` cuts it that way), so
 * every change is one mark, and a word's age is the age of the mark that first
 * covered its last character. Seeded with whatever is already on screen, dated
 * to before the beginning of time: a conversation reopened onto a turn that is
 * halfway through must not replay the half it missed.
 */
let marks: { len: number; ts: number }[] = [{ len: (props.text ?? '').length, ts: -1e9 }]

function ageOf(offset: number, now: number): number {
  for (const m of marks) if (m.len >= offset) return now - m.ts
  return 0
}

watch(
  () => props.text,
  (text, was) => {
    if (!props.live) return
    const now = performance.now()
    // A different message: none of the old timings mean anything for it.
    if (!was || !text.startsWith(was)) marks = []
    marks.push({ len: text.length, ts: now })
    // Everything already fully lit is one mark — the newest of them, so that
    // the offsets it covers still land on it. Dropping them outright instead
    // handed every old offset to the *next* mark, which is by definition a
    // young one: the whole paragraph read as having just arrived and sat at
    // zero opacity together.
    while (marks.length > 1 && now - marks[1]!.ts >= FADE) marks.shift()
  },
)

/** Idempotent: undoing the wrapping leaves exactly the markdown's own nodes. */
function undecorate(el: HTMLElement): void {
  for (const c of Array.from(el.querySelectorAll('span.caret'))) c.remove()
  for (const t of Array.from(el.querySelectorAll('span[data-tail]'))) {
    const p = t.parentNode
    if (!p) continue
    while (t.firstChild) p.insertBefore(t.firstChild, t)
    t.remove()
  }
  // Merging back the text nodes the splitting broke apart, and dropping the
  // empty ones it left behind, so the next pass measures the same text this one
  // did — per block, and never on the root. Vue anchors the `v-for` on empty
  // text nodes between the blocks, and `normalize()` deletes exactly those: it
  // took the patcher's anchors out from under it and every later update threw.
  // Inside a block there is nothing to break — that content is `v-html`, which
  // Vue writes whole and never diffs.
  for (const blk of Array.from(el.children)) blk.normalize()
}

const INLINE = new Set(['SPAN', 'CODE', 'STRONG', 'EM', 'B', 'I', 'A', 'DEL', 'SUP', 'SUB'])

/** Whether anything visible follows `n` among its siblings. */
function inkAfter(n: Node): boolean {
  for (let s = n.nextSibling; s; s = s.nextSibling) {
    if ((s.textContent ?? '').trim()) return true
  }
  return false
}

let fading = 0

function decorate(): void {
  if (fading) cancelAnimationFrame(fading)
  fading = 0
  const el = root.value
  if (!el) return
  undecorate(el)
  if (!props.live) return
  const block = el.lastElementChild
  if (!block) return

  // Every text node of the last block, with where it starts, measured before
  // anything is split so the offsets stay true as the walk moves backwards.
  const nodes: { node: Text; at: number }[] = []
  let total = 0
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text
    nodes.push({ node: t, at: total })
    total += t.data.length
  }

  const now = performance.now()
  const src = props.text.length
  let anchor: Node | null = null
  let young = false

  if (!reduced()) {
    let words = 0
    outer: for (let i = nodes.length - 1; i >= 0 && words < MAX_WORDS; i--) {
      const { node, at } = nodes[i]!
      while (words < MAX_WORDS) {
        const data = node.data
        let e = data.length
        while (e > 0 && SPACE.test(data[e - 1]!)) e--
        if (e === 0) break
        let b = e
        while (b > 0 && !SPACE.test(data[b - 1]!)) b--

        // Rendered text is shorter than its source by whatever syntax marked it
        // up, but only by a few characters within one word of the head, which
        // is the whole distance this measures over.
        const age = ageOf(src - (total - (at + e)), now)
        if (age >= FADE) break outer
        const p = age / FADE
        young = true

        // Split rather than surround: the word leaves in its own node and the
        // one being walked keeps everything before it, so the offsets already
        // measured stay valid and no wrap can nest inside the last one.
        node.splitText(e)
        const word = node.splitText(b)
        const span = document.createElement('span')
        span.dataset.tail = ''
        span.style.opacity = (1 - (1 - p) ** 3).toFixed(3)
        word.parentNode?.insertBefore(span, word)
        span.appendChild(word)
        if (!anchor) anchor = span
        words++
      }
    }
  }

  const caret = document.createElement('span')
  caret.className = 'caret'
  anchor ??= lastInk(block)
  if (!anchor?.parentNode) {
    block.appendChild(caret)
  } else {
    // Out of whatever *inline* element the sentence happens to end inside — a
    // caret left in the `<code>` chip would be painted on its background — and
    // no further: out of the paragraph it would sit on a line of its own.
    while (anchor.parentElement && INLINE.has(anchor.parentElement.tagName) && !inkAfter(anchor)) {
      anchor = anchor.parentElement
    }
    anchor.parentNode?.insertBefore(caret, anchor.nextSibling)
  }

  // The stream pausing must not leave a word half-lit: while anything is still
  // coming in, this keeps recomputing it after the text has stopped changing.
  if (young) fading = requestAnimationFrame(decorate)
}

/** The last text that is actually ink: markdown leaves a newline after every
 *  block, and hanging the caret off that put it on a line of its own. */
function lastInk(el: Element): Text | null {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if ((n as Text).data.trim()) last = n as Text
  }
  return last
}

// `post` is after the DOM this reads: the fade is put back on the new nodes in
// the same frame that replaced the old ones.
watch(blocks, decorate, { flush: 'post' })
onMounted(decorate)
onBeforeUnmount(() => {
  if (fading) cancelAnimationFrame(fading)
})
</script>

<template>
  <div ref="root" class="md selectable" :class="{ live }">
    <div v-for="(b, i) in blocks" :key="i" class="blk" v-html="b" />
  </div>
</template>

<style scoped>
/* Tuned to read as prose in a transcript rather than as a document: tight
   leading, no top margin on the first block, nothing that adds vertical drift
   when a dozen of these stack up inside one turn. */
.md {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-muted);
  word-break: break-word;
}
/* The block wrappers carry no box of their own — no padding, no border, no
   overflow — so the margins inside them still collapse the way they did when
   this was one element, and the rhythm is unchanged. */
.blk { margin: 0; }
.md :deep(.blk > *:first-child) { margin-top: 0; }
.md > .blk:last-child :deep(> *:last-child) { margin-bottom: 0; }

/* A block that arrives while the message is being written comes up out of
   nothing, so a code fence's border and background do not snap in around text
   that is still fading. Opacity only, and shorter than the word fade it sits
   under: it used to also rise 3px, which moved words the fade was brightening
   at the same time, inside a column that is scrolling to follow them — three
   motions at once, reading as jitter. A finished message is not animated at
   all, so the durable event swapping in under the draft moves nothing. */
.md.live > .blk { animation: blockin var(--dur-2) var(--ease-soft) both; }
@keyframes blockin {
  from { opacity: 0; }
  to { opacity: 1; }
}

.md :deep(p) { margin: 0 0 9px; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) {
  margin: 14px 0 7px;
  font-size: var(--fs-sm);
  font-weight: 650;
  color: var(--text);
  letter-spacing: -0.005em;
}
.md :deep(h1) { font-size: 15px; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 9px; padding-left: 20px; }
.md :deep(li) { margin: 2px 0; }
.md :deep(li::marker) { color: var(--text-dim); }
.md :deep(strong) { color: var(--text); font-weight: 620; }
.md :deep(a) { color: var(--accent); text-decoration: none; }
.md :deep(a:hover) { text-decoration: underline; }
.md :deep(blockquote) {
  margin: 0 0 9px;
  padding: 2px 0 2px 11px;
  border-left: 2px solid var(--line-strong);
  color: var(--text-dim);
}
.md :deep(hr) { border: none; border-top: 1px solid var(--line); margin: 12px 0; }

.md :deep(code.cm-inline) {
  font-family: var(--mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text);
}
/* Wide content scrolls inside its own box; the transcript column never does. */
.md :deep(pre.cm-code) {
  margin: 0 0 10px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  overflow-x: auto;
}
.md :deep(pre.cm-code code) {
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--text);
  white-space: pre;
}
/* The language, where a fence declared one — small, and out of the way. */
.md :deep(pre.cm-code[data-lang])::before {
  content: attr(data-lang);
  display: block;
  margin: -3px 0 6px;
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.md :deep(table) { width: 100%; border-collapse: collapse; margin: 0 0 10px; font-size: var(--fs-xs); }
.md :deep(th), .md :deep(td) { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
.md :deep(th) { background: var(--bg-sunken); color: var(--text); font-weight: 600; }

/* Where the writing has got to. Inside the text now rather than under it: it
   used to sit after a block element and so always started a line of its own. */
.md :deep(span.caret) {
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--agent);
  animation: pulse 1.1s var(--ease-soft) infinite;
}
</style>
