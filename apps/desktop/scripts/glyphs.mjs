/**
 * The Cockpit type face — the one place the letterforms live.
 *
 * Both `logo.mjs` (the wordmark and the mark drawn in the window) and
 * `icon.mjs` (the file macOS puts in the Dock) cut their shapes from this
 * module, so the app icon can never drift away from the mark beside it in the
 * rail.
 *
 * The face is squared, solid and heavy. Two cuts came before it: a humanist
 * lowercase with rounded corner pixels and an ordered dither around every
 * stroke — which read as a font rendered small rather than as a mark, the
 * corner cuts being the first thing to go at 14px and the dither filling the
 * counters of C, O and P with checkerboard at every size — and then a light
 * slab at 2px on 7. This one is 3px on 9 in a 12-row box, and the weight is
 * the point: at a third of the cap height the counters close to slots, the
 * word reads as one dark shape before it reads as seven letters, and the
 * silhouette survives being 18px tall in the rail.
 */

/* 12 rows, cap height only — this face has no lowercase and no descender.
   Every stroke is 3px on a 9px em: the previous cut was 2 on 7, and against
   the display faces this one is measured on, that read as an outline of a
   logo rather than a logo. A third of the cap height is the weight at which
   the counters close down to slots and the word becomes a shape you can
   recognise across a room. */
export const ROWS = 12

/* One width for every letter, including I and T. Uniform advance is what
   makes a slab face read as a device readout rather than as type set badly;
   it also means a 3px stem can sit dead centre, which it cannot in an even
   width. */
export const GLYPHS = {
  C: [
    '#########',
    '#########',
    '#########',
    '###......',
    '###......',
    '###......',
    '###......',
    '###......',
    '###......',
    '#########',
    '#########',
    '#########',
  ],
  O: [
    '#########',
    '#########',
    '#########',
    '###...###',
    '###...###',
    '###...###',
    '###...###',
    '###...###',
    '###...###',
    '#########',
    '#########',
    '#########',
  ],
  /* The one glyph with a diagonal. It steps one column per row rather than
     following a true 45°, and the arms are the same 3px as everything else —
     they only look thinner because a diagonal always does. */
  K: [
    '###...###',
    '###...###',
    '###..###.',
    '###.###..',
    '######...',
    '######...',
    '######...',
    '######...',
    '###.###..',
    '###..###.',
    '###...###',
    '###...###',
  ],
  P: [
    '#########',
    '#########',
    '#########',
    '###...###',
    '###...###',
    '###...###',
    '#########',
    '#########',
    '#########',
    '###......',
    '###......',
    '###......',
  ],
  I: [
    '#########',
    '#########',
    '#########',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '#########',
    '#########',
    '#########',
  ],
  T: [
    '#########',
    '#########',
    '#########',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
  ],
}

/* The gap tracks the stroke: one third of it and the word is a wall, one
   whole stroke and it is seven signs standing apart. Two thirds — 2 of the
   3px stem — is where the letters stay separate and the word stays one
   object. */
export const LETTER_GAP = 2

/**
 * Lay a word out on the grid.
 *
 * Returns the lit cells as a set of "x,y" keys, the total width, and — because
 * the caller usually wants to tint the first letter differently — the column
 * span each letter occupies.
 */
export function compose(word) {
  const cells = new Set()
  const spans = []
  let x = 0
  for (const ch of word) {
    const g = GLYPHS[ch]
    if (!g) throw new Error('no glyph for ' + ch)
    const w = g[0].length
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < w; c++) {
        if (g[r][c] === '#') cells.add(x + c + ',' + r)
      }
    }
    spans.push({ ch, x0: x, x1: x + w - 1 })
    x += w + LETTER_GAP
  }
  return { cells, spans, width: x - LETTER_GAP, height: ROWS }
}

/** Merge each row of cells into horizontal runs — far fewer nodes, same shape. */
export function runs(cells) {
  const byRow = new Map()
  for (const key of cells) {
    const [x, y] = key.split(',').map(Number)
    const arr = byRow.get(y) ?? []
    arr.push(x)
    byRow.set(y, arr)
  }
  const out = []
  for (const [y, xs] of [...byRow].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b)
    let start = xs[0]
    let prev = xs[0]
    for (let i = 1; i <= xs.length; i++) {
      if (xs[i] === prev + 1) {
        prev = xs[i]
        continue
      }
      out.push([start, y, prev - start + 1])
      start = xs[i]
      prev = xs[i]
    }
  }
  return out
}
