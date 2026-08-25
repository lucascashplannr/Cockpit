/**
 * The Cockpit mark is generated, not drawn.
 *
 * A wordmark made of pixels only stays honest if the pixels are real: a bitmap
 * font on a 12-row grid, run-length merged into rectangles, with a deterministic
 * ordered dither around every stroke. Nothing here is hand-placed, so the mark
 * can be re-cut at any size — or for any word — without a design tool.
 *
 *   node apps/desktop/scripts/logo.mjs
 *
 * Writes the two Vue brand components (currentColor, theme-aware) and the two
 * standalone SVGs used outside the app (README, packaging).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')

/* ── the font ──────────────────────────────────────────────────────────
 * 12 rows: 0–8 above the baseline, 9–11 the descender. Stems are 2px, so
 * the shapes stay legible when the whole word is 14px tall in the rail.
 */
const GLYPHS = {
  C: [
    '..####..',
    '.######.',
    '##....##',
    '##......',
    '##......',
    '##......',
    '##....##',
    '.######.',
    '..####..',
    '........',
    '........',
    '........',
  ],
  o: [
    '.......',
    '.......',
    '.......',
    '.#####.',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '.#####.',
    '.......',
    '.......',
    '.......',
  ],
  c: [
    '.......',
    '.......',
    '.......',
    '.#####.',
    '##...##',
    '##.....',
    '##.....',
    '##...##',
    '.#####.',
    '.......',
    '.......',
    '.......',
  ],
  k: [
    '##....',
    '##....',
    '##....',
    '##..##',
    '##.##.',
    '####..',
    '####..',
    '##.##.',
    '##..##',
    '......',
    '......',
    '......',
  ],
  p: [
    '.......',
    '.......',
    '.......',
    '######.',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
    '######.',
    '##.....',
    '##.....',
    '##.....',
  ],
  i: [
    '##',
    '##',
    '..',
    '##',
    '##',
    '##',
    '##',
    '##',
    '##',
    '..',
    '..',
    '..',
  ],
  t: [
    '.....',
    '.##..',
    '.##..',
    '#####',
    '.##..',
    '.##..',
    '.##..',
    '.##..',
    '.####',
    '.....',
    '.....',
    '.....',
  ],
}

const ROWS = 12
const LETTER_GAP = 3

/** Lay a word out on the grid; returns the set of lit cells and the width. */
function compose(word) {
  const cells = new Set()
  let x = 0
  for (const ch of word) {
    const g = GLYPHS[ch]
    if (!g) throw new Error('no glyph for ' + ch)
    const w = g[0].length
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < w; c++) {
        if (g[r][c] === '#') cells.add((x + c) + ',' + r)
      }
    }
    x += w + LETTER_GAP
  }
  return { cells, width: x - LETTER_GAP, height: ROWS }
}

/**
 * The dither. Two ordered rings outside the letterform — a checkerboard at
 * distance 1, a quarter grid at distance 2 — plus a checkerboard erosion of
 * the pixels along the top edge of every stroke. Ordered, never random: the
 * same word always cuts the same mark.
 */
function dither(cells, width, height) {
  const on = (x, y) => cells.has(x + ',' + y)
  const near = (x, y, d) => {
    for (let dy = -d; dy <= d; dy++) {
      for (let dx = -d; dx <= d; dx++) if (on(x + dx, y + dy)) return true
    }
    return false
  }

  const ring1 = []
  const ring2 = []
  for (let y = -2; y < height + 2; y++) {
    for (let x = -2; x < width + 2; x++) {
      if (on(x, y)) continue
      if (near(x, y, 1)) {
        if ((x + y) % 2 === 0) ring1.push([x, y])
      } else if (near(x, y, 2)) {
        if (x % 2 === 0 && y % 2 === 0) ring2.push([x, y])
      }
    }
  }

  // Erosion: a lit pixel with sky directly above it, every other column.
  const eroded = new Set()
  for (const key of cells) {
    const [x, y] = key.split(',').map(Number)
    if (!on(x, y - 1) && (x + y) % 2 === 0 && y > 0) eroded.add(key)
  }

  const solid = [...cells].filter((k) => !eroded.has(k)).map((k) => k.split(',').map(Number))
  return { solid, eroded: [...eroded].map((k) => k.split(',').map(Number)), ring1, ring2 }
}

/** Merge each row of cells into horizontal runs — far fewer nodes, same shape. */
function runs(list) {
  const byRow = new Map()
  for (const [x, y] of list) {
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

function rects(list, indent) {
  return runs(list)
    .map(([x, y, w]) => `${indent}<rect x="${x}" y="${y}" width="${w}" height="1" />`)
    .join('\n')
}

function layers(word) {
  const { cells, width, height } = compose(word)
  const d = dither(cells, width, height)
  const pad = 2

  // Trim to the ink: a mark with no descender must not carry the room for one.
  let top = ROWS
  let bottom = 0
  for (const key of cells) {
    const y = Number(key.split(',')[1])
    if (y < top) top = y
    if (y > bottom) bottom = y
  }
  const body = [
    `  <g opacity="1">\n${rects(d.solid, '    ')}\n  </g>`,
    `  <g opacity="0.62">\n${rects(d.eroded, '    ')}\n  </g>`,
    `  <g opacity="0.42">\n${rects(d.ring1, '    ')}\n  </g>`,
    `  <g opacity="0.15">\n${rects(d.ring2, '    ')}\n  </g>`,
  ].join('\n')
  return {
    viewBox: `${-pad} ${top - pad} ${width + pad * 2} ${bottom - top + 1 + pad * 2}`,
    width: width + pad * 2,
    height: bottom - top + 1 + pad * 2,
    body,
  }
}

function vue(word, name, comment) {
  const l = layers(word)
  return `<script setup lang="ts">
/**
 * ${comment}
 *
 * Generated by apps/desktop/scripts/logo.mjs — edit the generator, not this file.
 * Every pixel is a rect on a ${ROWS}-row grid; the fringe is an ordered dither,
 * so the mark stays itself at 14px and at 400px.
 */
withDefaults(defineProps<{ height?: number }>(), { height: ${l.height * 2} })
<\/script>

<template>
  <svg
    class="brand"
    :height="height"
    :width="(height * ${l.width}) / ${l.height}"
    viewBox="${l.viewBox}"
    fill="currentColor"
    shape-rendering="crispEdges"
    role="img"
    aria-label="${word}"
  >
${l.body}
  </svg>
</template>

<style scoped>
.brand {
  display: block;
  flex: none;
}
</style>
`
}

function svg(word) {
  const l = layers(word)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width * 8}" height="${l.height * 8}" viewBox="${l.viewBox}" fill="#6b7280" shape-rendering="crispEdges">
${l.body}
</svg>
`
}

mkdirSync(resolve(app, 'src/components/brand'), { recursive: true })
mkdirSync(resolve(app, 'src/assets'), { recursive: true })

writeFileSync(
  resolve(app, 'src/components/brand/Wordmark.vue'),
  vue('Cockpit', 'Wordmark', 'The full wordmark — used where the app introduces itself.'),
)
writeFileSync(
  resolve(app, 'src/components/brand/Mark.vue'),
  vue('C', 'Mark', 'The compact mark — the rail, the dock, anywhere the word will not fit.'),
)
writeFileSync(resolve(app, 'src/assets/wordmark.svg'), svg('Cockpit'))
writeFileSync(resolve(app, 'src/assets/mark.svg'), svg('C'))

console.log('wrote Wordmark.vue, Mark.vue, wordmark.svg, mark.svg')
