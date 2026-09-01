/**
 * The app icon, cut from the same grid as the mark in the rail.
 *
 *   node apps/desktop/scripts/icon.mjs
 *
 * Electron ships its own icon and uses it for anything that does not supply
 * one, which is why the Dock said "Electron" — a window can be branded from
 * CSS, a Dock tile cannot. This writes the real thing:
 *
 *   build/icon.png      1024px, what `app.dock.setIcon` loads in development
 *   build/icon.icns     the macOS bundle icon, every size Finder asks for
 *   build/icon.iconset  the sizes it was built from, kept for inspection
 *
 * No image library. The mark is a bitmap to begin with, so the honest way to
 * render it is to write the pixels: a superellipse tile, a vertical gradient,
 * and the grid on top, sampled 4x4 per pixel. Every size is rendered rather
 * than scaled down from one master, so no edge is resampled twice.
 */

import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compose } from './glyphs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '..', 'build')

/* ── the look ──────────────────────────────────────────────────────────
 * Fixed colours, not tokens: the Dock has no theme to follow, and an icon
 * that changed with the system appearance would only ever be half right.
 *
 * The tile is a blue slate rather than the app's own near-black, and the ink
 * a pale periwinkle rather than the saturated accent. Both are deliberate:
 * an almost-black tile disappears into a dark Dock and a saturated mark on it
 * vibrates, where slate reads as a surface at 16px and the pale ink sits on
 * it quietly. The hue is the accent's, two steps apart in lightness, so the
 * icon and the window are still obviously the same object.
 */
const TILE_TOP = [0x2f, 0x34, 0x47]
const TILE_BOTTOM = [0x1a, 0x1e, 0x2a]
const INK = [0xc9, 0xd3, 0xf8]
const RIM = [0xff, 0xff, 0xff]
const RIM_ALPHA = 0.16

/* Apple draws the macOS icon on 824 of 1024 points with a continuous corner.
   A superellipse at n=5 is within a pixel of that curve at every size we
   emit, and unlike a rounded rect it has no visible join where the arc meets
   the straight edge. */
const TILE = 824 / 1024
const N = 5

/* The C fills 42% of the canvas height — a little over half the tile, which
   is where a mark stops looking cramped and stops looking like it is falling
   off the edge. */
const INK_HEIGHT = 0.42

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Render one square icon as RGBA bytes.
 *
 * `ss` subsamples per axis. The tile edge and the grid edges are both hard
 * tests, so all of the antialiasing comes from this — 4x4 gives 16 levels,
 * which is past the point where the curve reads as stepped at any size Finder
 * draws.
 */
function render(size) {
  const ss = 4
  const px = Buffer.alloc(size * size * 4)
  const { cells, width: gw, height: gh } = compose('C')

  const cell = (size * INK_HEIGHT) / gh
  const x0 = (size - gw * cell) / 2
  const y0 = (size - gh * cell) / 2

  const a = (size * TILE) / 2
  const c = size / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let al = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss
          const fy = y + (sy + 0.5) / ss

          const dx = Math.abs(fx - c) / a
          const dy = Math.abs(fy - c) / a
          const d = Math.pow(dx, N) + Math.pow(dy, N)
          if (d > 1) continue

          const t = fy / size
          let cr = lerp(TILE_TOP[0], TILE_BOTTOM[0], t)
          let cg = lerp(TILE_TOP[1], TILE_BOTTOM[1], t)
          let cb = lerp(TILE_TOP[2], TILE_BOTTOM[2], t)

          /* A hairline of light along the top edge. Without it the tile reads
             as a flat sticker against a dark Dock; with it, as a surface. */
          const band = clamp01((d - 0.9) / 0.1)
          const up = clamp01((c - fy) / a)
          const rim = band * band * up * RIM_ALPHA
          if (rim > 0) {
            cr = lerp(cr, RIM[0], rim)
            cg = lerp(cg, RIM[1], rim)
            cb = lerp(cb, RIM[2], rim)
          }

          const gx = Math.floor((fx - x0) / cell)
          const gy = Math.floor((fy - y0) / cell)
          if (cells.has(gx + ',' + gy)) {
            cr = INK[0]
            cg = INK[1]
            cb = INK[2]
          }

          r += cr
          g += cg
          b += cb
          al += 1
        }
      }

      const i = (y * size + x) * 4
      if (al === 0) continue
      // Straight (unpremultiplied) alpha: the colour is the average of the
      // samples that landed on the tile, not of the whole pixel, or the edge
      // would darken towards transparent black.
      px[i] = Math.round(r / al)
      px[i + 1] = Math.round(g / al)
      px[i + 2] = Math.round(b / al)
      px[i + 3] = Math.round((al / (ss * ss)) * 255)
    }
  }
  return px
}

/* ── PNG ───────────────────────────────────────────────────────────────
 * Eight-bit RGBA, one IDAT, filter 0 on every scanline. zlib is in Node, and
 * that is the only part of a PNG that is not a header.
 */
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* Finder asks for these ten sizes, and there is no smallest one worth
   simplifying for: the mark is nine rows tall, so even the 16px tile gets a
   whole grid cell per two device pixels. */
const SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

mkdirSync(out, { recursive: true })
const iconset = join(out, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

/* One render per distinct size, reused by both entries that ask for it —
   icon_32x32.png and icon_16x16@2x.png are the same image. */
const cache = new Map()
const bytes = (size) => {
  if (!cache.has(size)) cache.set(size, png(size, render(size)))
  return cache.get(size)
}

for (const [name, size] of SIZES) writeFileSync(join(iconset, name), bytes(size))
writeFileSync(join(out, 'icon.png'), bytes(1024))

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(out, 'icon.icns')])

console.log('wrote build/icon.png, build/icon.icns (' + SIZES.length + ' sizes)')
