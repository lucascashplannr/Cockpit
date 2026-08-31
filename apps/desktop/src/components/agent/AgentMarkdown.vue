<script setup lang="ts">
import { computed } from 'vue'
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
 */
const props = defineProps<{ text: string }>()

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

const html = computed(() => md.parse(props.text ?? '', { async: false }) as string)
</script>

<template>
  <div class="md selectable" v-html="html" />
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
.md :deep(> *:first-child) { margin-top: 0; }
.md :deep(> *:last-child) { margin-bottom: 0; }
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
</style>
