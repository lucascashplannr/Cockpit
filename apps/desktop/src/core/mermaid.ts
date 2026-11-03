import type { Mermaid } from 'mermaid'

/**
 * A ```mermaid fence drawn as the diagram it describes, for the markdown
 * preview (Diff, Code, Docs).
 *
 * Mermaid is large, so it is loaded the first time a page holds a diagram and
 * not before. It runs with `securityLevel: 'strict'`: labels are sanitised and
 * click handlers are off — a file in a worktree is mostly the agent's writing,
 * and the preview's rule is that nothing in it executes.
 *
 * `initialize` sets one global config, so renders go through a queue: two
 * previews in different themes must not swap configs halfway through.
 */

let loading: Promise<Mermaid> | null = null
let queue: Promise<unknown> = Promise.resolve()
let seq = 0
const cache = new Map<string, Promise<string>>()

const FONT = '"Geist Variable", system-ui, sans-serif'

/** The tokens' own values (tokens.css): Mermaid needs colours, not `light-dark()`. */
function palette(dark: boolean): Record<string, string | boolean> {
  const c = dark
    ? { text: '#ecedf3', muted: '#9899a9', node: '#1a1a21', border: '#383842', line: '#7a7b8c', group: '#0c0c10', groupLine: '#27272f', panel: '#121217', note: '#24242c' }
    : { text: '#16161c', muted: '#5b5b69', node: '#f2f2f6', border: '#c9c9d4', line: '#8c8c9c', group: '#fafafc', groupLine: '#dfdfe7', panel: '#ffffff', note: '#ececf1' }
  return {
    darkMode: dark,
    fontFamily: FONT,
    fontSize: '13px',
    background: c.panel,
    primaryColor: c.node,
    primaryTextColor: c.text,
    primaryBorderColor: c.border,
    secondaryColor: c.group,
    tertiaryColor: c.group,
    mainBkg: c.node,
    nodeBorder: c.border,
    nodeTextColor: c.text,
    textColor: c.text,
    titleColor: c.muted,
    lineColor: c.line,
    clusterBkg: c.group,
    clusterBorder: c.groupLine,
    edgeLabelBackground: c.panel,
    noteBkgColor: c.note,
    noteTextColor: c.text,
    noteBorderColor: c.border,
    actorBkg: c.node,
    actorBorder: c.border,
    actorTextColor: c.text,
    signalColor: c.line,
    signalTextColor: c.text,
  }
}

/** Relative luminance of `#rgb` / `#rrggbb`, or null for anything else. */
function luminance(hex: string): number | null {
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return null
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * A `classDef` that sets a fill but no `color` was written for one theme: a
 * pastel box keeps the dark theme's light text and reads as an empty white
 * box. Such a node's label is given whichever of our two inks reads on it.
 */
function readableLabels(svg: string): string {
  const t = document.createElement('template')
  t.innerHTML = svg
  let touched = false
  for (const node of t.content.querySelectorAll('g.node')) {
    const shape = node.querySelector('rect, polygon, path, circle, ellipse')
    const fill = /(?:^|;)\s*fill:\s*(#[0-9a-f]{3,8})\b/i.exec(shape?.getAttribute('style') ?? '')?.[1]
    const l = fill ? luminance(fill) : null
    if (l === null) continue
    const labels = node.querySelectorAll<SVGElement | HTMLElement>('.nodeLabel, text')
    if ([...labels].some((el) => /(?:^|;)\s*(?:color|fill):/i.test(el.getAttribute('style') ?? ''))) continue
    const ink = l > 0.4 ? '#16161c' : '#ecedf3'
    for (const el of labels) {
      el.style.setProperty(el.tagName.toLowerCase() === 'text' ? 'fill' : 'color', ink)
      touched = true
    }
  }
  return touched ? t.innerHTML : svg
}

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  return loading
}

/** The diagram as SVG markup, or a rejection carrying Mermaid's parse error. */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const key = (dark ? 'd:' : 'l:') + source
  const hit = cache.get(key)
  if (hit) return hit
  const job = queue.then(async () => {
    const mermaid = await load()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      fontFamily: FONT,
      themeVariables: palette(dark),
    })
    const id = 'cockpit-mmd-' + ++seq
    try {
      const { svg } = await mermaid.render(id, source)
      return readableLabels(svg)
    } finally {
      // A failed render can leave its scratch node behind in <body>.
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
    }
  })
  queue = job.catch(() => undefined)
  cache.set(key, job)
  // Failures are kept too: an unchanged broken fence is not retried on every
  // repaint. Capped, so a long editing session does not grow it.
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return job
}
