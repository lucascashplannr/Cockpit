import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { php } from '@codemirror/lang-php'

/**
 * What the Code tool and the Diff's whole-file view have in common: one editor,
 * dressed the same, wherever a file is shown as itself.
 */

export function languageFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue'].includes(ext)) return javascript({ typescript: true, jsx: true })
  if (ext === 'json') return json()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  if (ext === 'css') return css()
  if (['html', 'htm'].includes(ext)) return html()
  if (ext === 'php') return php()
  return []
}

/** A theme built from the same tokens as the rest of the app, so the editor
 *  does not look like a different product embedded in this one. */
export const cockpitTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', padding: '8px 0 40px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-dim)',
    border: 'none',
    fontFamily: 'var(--mono)',
    fontSize: 'var(--fs-xs)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.55' },
})
