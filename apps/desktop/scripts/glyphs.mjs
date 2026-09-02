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
  /* The bracket at x=3 is the C's alone, and it is the one place a letter
     here is drawn rather than ruled. Everywhere else an arm meets the stem
     the counter is closed and the join needs no help; here the counter opens
     to the em edge and the corner is the widest, emptiest thing in the mark —
     which is what made this C read as a bracket rather than a letter. One
     cell of ink in each inside corner steps the transition. The C's *outer*
     corners are not drawn here: they are cut by `chamfer`, along with every
     other letter's. */
  C: [
    '#########',
    '#########',
    '#########',
    '####.....',
    '###......',
    '###......',
    '###......',
    '###......',
    '####.....',
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

/* One cell off each corner of the em box, wherever ink reaches it.
 *
 * The cut started on the C, where it is doing the most work — a C is the one
 * letter in this word whose outline is a curve in every other face, and a
 * corner taken is as much of that curve as twelve rows will hold. But a face
 * where one letter is cut and six are square is not a face, so it is a rule:
 * the em box is the word's outer boundary, and the boundary is bevelled
 * wherever it turns. Edges facing inward — the C's mouth, the counters, the
 * inside of K's fork — stay sharp, which is what keeps the letters legible
 * at 18px while the silhouette softens.
 *
 * One cell, never two. A second would round the mark, and a rounded mark
 * does not survive being 18px tall in the rail.
 */
const CORNERS = [
  [0, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
]
function chamfer(glyph) {
  const rows = glyph.slice()
  const w = rows[0].length
  for (const [cx, cy] of CORNERS) {
    const x = cx < 0 ? w + cx : cx
    const y = cy < 0 ? ROWS + cy : cy
    if (rows[y][x] !== '#') continue
    rows[y] = rows[y].slice(0, x) + '.' + rows[y].slice(x + 1)
  }
  return rows
}

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
    if (!GLYPHS[ch]) throw new Error('no glyph for ' + ch)
    const g = chamfer(GLYPHS[ch])
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
