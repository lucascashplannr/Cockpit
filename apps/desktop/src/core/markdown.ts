import { Marked } from 'marked'

/**
 * The one markdown renderer in the window, shared by the transcript and the
 * Diff's preview of a `.md` file.
 *
 * Raw HTML never reaches the DOM. The renderer below emits only the tags it
 * writes itself and escapes everything else, so a model that produces a
 * `<script>` — or is talked into producing one by a file it just read — yields
 * visible text rather than an execution. A file in a worktree is no safer: the
 * agent wrote most of them. `v-html` in a renderer with `nodeIntegration:
 * false` is still a renderer.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Only absolute `http(s)` and `mailto`. A `javascript:` href is the other half
 * of the hole the escaping closes; a relative one (`../frontend/naming.md`)
 * would resolve against the app's own origin and open that in a browser.
 */
function safeHref(href: string): string | null {
  try {
    const u = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? href : null
  } catch {
    return null
  }
}

/** The fences a shell can run as they stand. */
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'shellsession'])

const svg = (body: string) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  body + '</svg>'
const COPY = svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>')
const CHECK = svg('<path d="M20 6 9 17l-5-5"/>')
const PLAY = svg('<polygon points="6 3 20 12 6 21 6 3"/>')

/**
 * A fence's buttons, written as markup because the block itself is: the
 * transcript renders through `v-html`, so the clicks are caught by the
 * component that holds it (`data-act`), not bound here.
 */
function codeActions(lang: string): string {
  const btn = (act: string, title: string, icons: string) =>
    '<button type="button" class="cm-act" data-act="' + act + '" title="' + title + '" aria-label="' + title + '">' +
    icons + '</button>'
  return (
    '<span class="cm-acts">' +
    (SHELL_LANGS.has(lang.toLowerCase()) ? btn('run', 'Run in the Terminal', PLAY) : '') +
    btn('copy', 'Copy', '<span class="cm-i">' + COPY + '</span><span class="cm-ok">' + CHECK + '</span>') +
    '</span>'
  )
}

/**
 * `breaks` is the one difference between the two readers. A model's reply
 * means its newlines; a file on disk is hard-wrapped at 80 columns and means
 * paragraphs, the way every other markdown renderer reads it.
 *
 * `actions` puts Copy — and Run, on a shell fence — on each code block. Only
 * the transcript asks: a command there is one to use, while in a file it is
 * one to read.
 */
export function createMarked(opts: { breaks: boolean; actions?: boolean }): Marked {
  const md = new Marked({ gfm: true, breaks: opts.breaks })
  md.use({
    renderer: {
      // Raw HTML in, escaped text out — in both block and inline position.
      html({ raw }: { raw: string }) {
        return escapeHtml(raw)
      },
      code({ text, lang }: { text: string; lang?: string }) {
        const l = (lang ?? '').split(/\s+/)[0] ?? ''
        const pre =
          '<pre class="cm-code"' + (l ? ' data-lang="' + escapeHtml(l) + '"' : '') +
          '><code>' + escapeHtml(text) + '</code></pre>'
        if (!opts.actions) return pre
        return '<div class="cm-block">' + pre + codeActions(l) + '</div>'
      },
      codespan({ text }: { text: string }) {
        return '<code class="cm-inline">' + escapeHtml(text) + '</code>'
      },
      link({ href, tokens }) {
        // The label is rendered from its tokens, never from `text`: that is
        // the raw source, and `[<img onerror=…>](https://…)` would go in as is.
        const text = this.parser.parseInline(tokens)
        const safe = safeHref(href)
        if (!safe) return text
        // §2 — the window is not a browser: a link leaves it, and never
        // navigates the app away from itself.
        return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noreferrer noopener">' + text + '</a>'
      },
      image({ text }: { text: string }) {
        return escapeHtml(text)
      },
    },
  })
  return md
}
