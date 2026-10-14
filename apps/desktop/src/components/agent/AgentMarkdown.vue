<script setup lang="ts">
import { computed } from 'vue'
import { createMarked } from '../../core/markdown.js'
import { runInTerminal, toast } from '../../core/store.js'

/**
 * What the engine wrote, as it meant it to read.
 *
 * The transcript used to be `white-space: pre-wrap` on a bare span, so every
 * heading, list and fenced block arrived as its own literal syntax — the one
 * place in the app where what is on screen was the source rather than the
 * result. A model writes markdown whether or not anyone renders it.
 *
 * Raw HTML never reaches the DOM — `core/markdown.ts` says how.
 *
 * `live` is the same message while it is still being written: the text is
 * paced by `usePaced` before it gets here, and the only thing this adds for it
 * is holding back half-typed markdown markers. Nothing about the finished
 * render differs, so the durable event replacing the draft lands without a
 * flicker.
 */
const props = defineProps<{ text: string; live?: boolean }>()

const md = createMarked({ breaks: true, actions: true })

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

/* ── how a streamed message arrives ───────────────────────────────────────
 *
 * One rule: a block fades in when it appears, and nothing else moves.
 *
 * This used to animate every *word* — each one wrapped in a span whose opacity
 * was a function of how long ago it arrived, recomputed every frame, with a
 * blinking caret walked to the end of the sentence. It was three animations
 * running over text that was itself growing, and it read exactly as Lucas
 * described it: a glitch. The machinery was also the most delicate code in the
 * window (splitting text nodes under Vue's own patcher, then un-splitting them
 * before the next pass) for an effect nobody asked for.
 *
 * A block appearing is the only event a reader actually needs marked, and CSS
 * can mark it on its own: `blockin` below, once, on mount. The rest of the
 * calm comes from `usePaced`, which is not an animation — it is the text
 * arriving at a readable rate instead of in slabs.
 */

/* ── a fence's Copy and Run ───────────────────────────────────────────
 *
 * The buttons arrive inside the rendered HTML (`core/markdown.ts`), so the
 * clicks are caught here, on the message, and read the block they sit in. */

/** A `console` fence writes its prompt; the shell would read `$` as a command. */
function command(code: string): string {
  const lines = code.split('\n')
  const typed = lines.filter((l) => l.trim())
  return typed.length && typed.every((l) => /^\s*\$ /.test(l))
    ? lines.map((l) => l.replace(/^\s*\$ /, '')).join('\n')
    : code
}

async function onClick(ev: MouseEvent): Promise<void> {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.cm-act')
  const code = btn?.closest('.cm-block')?.querySelector('pre code')?.textContent
  if (!btn || code == null) return
  if (btn.dataset.act === 'run') {
    runInTerminal(command(code))
    return
  }
  try {
    await navigator.clipboard.writeText(code)
    btn.classList.add('done')
    window.setTimeout(() => btn.classList.remove('done'), 1400)
  } catch {
    toast('error', 'could not copy')
  }
}

</script>

<template>
  <div class="md selectable" :class="{ live }" @click="onClick">
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

/* A paragraph, a list, a code fence: each fades in once, as it appears. That
   is the whole of the streaming animation.

   Opacity only, and no movement: this sits inside a column that is already
   scrolling to follow the text, and anything that also travels reads as
   jitter. A finished message is not animated at all, so the durable event
   swapping in under the draft moves nothing. */
.md.live > .blk { animation: blockin 260ms var(--ease-soft) both; }
@keyframes blockin {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .md.live > .blk { animation: none; }
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
/* The buttons share the language's line, at the other end of it. They stand
   outside the `pre`, which scrolls sideways, so a long line never carries
   them off the card. */
.md :deep(.cm-block) { position: relative; margin: 0 0 10px; }
.md :deep(.cm-block > pre.cm-code) { margin: 0; }
.md :deep(.cm-acts) {
  position: absolute;
  top: 5px;
  right: 6px;
  display: flex;
  gap: 2px;
}
.md :deep(.cm-act) {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.md :deep(.cm-act:hover) { background: var(--hover); color: var(--text); }
.md :deep(.cm-act svg) { width: 13px; height: 13px; display: block; }
.md :deep(.cm-act .cm-ok) { display: none; }
.md :deep(.cm-act.done .cm-i) { display: none; }
.md :deep(.cm-act.done .cm-ok) { display: block; color: var(--ok); }
/* A fence with no language has no label line to share: room for the buttons
   is made on the first line instead, so they never sit on the code. */
.md :deep(.cm-block > pre.cm-code:not([data-lang])) { padding-right: 36px; }

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

</style>
