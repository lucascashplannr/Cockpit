/**
 * §12 — "L'objectif « 1 à 3 clics » est en réalité un objectif zéro clic."
 * The palette is the real entry point, so its matching has to feel instant and
 * forgiving: subsequence matching with a bias for word starts.
 */

export interface Scored<T> {
  item: T
  score: number
  positions: number[]
}

export function fuzzyScore(haystack: string, needle: string): { score: number; positions: number[] } | null {
  if (!needle) return { score: 0, positions: [] }
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()

  // Exact substring wins outright, and an exact prefix wins harder.
  const idx = h.indexOf(n)
  if (idx >= 0) {
    const positions = Array.from({ length: n.length }, (_, i) => idx + i)
    let score = 1000 - idx
    if (idx === 0) score += 500
    if (idx > 0 && /[\s\-_/.]/.test(h[idx - 1] ?? '')) score += 250
    return { score, positions }
  }

  let hi = 0
  let score = 0
  const positions: number[] = []
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni]!
    let found = -1
    while (hi < h.length) {
      if (h[hi] === c) {
        found = hi
        break
      }
      hi++
    }
    if (found === -1) return null
    positions.push(found)
    // Consecutive characters and word boundaries are what make a match read
    // as intentional rather than accidental.
    if (ni > 0 && positions[ni - 1] === found - 1) score += 12
    if (found === 0 || /[\s\-_/.]/.test(h[found - 1] ?? '')) score += 18
    score += Math.max(0, 10 - found / 8)
    hi++
  }
  return { score, positions }
}

/**
 * Several words are several things to find, in any order: "close topic" has to
 * find "Close “test”" under the Topic heading, and so does "topic close".
 *
 * Each word must appear as written. Letting every word match as a scattered
 * subsequence would find "topic" in half the hints in the list; a single word
 * keeps the forgiving match, because one word is where people abbreviate.
 */
export function fuzzyMatch(haystack: string, needle: string): { score: number; positions: number[] } | null {
  const words = needle.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return fuzzyScore(haystack, needle.trim())
  const h = haystack.toLowerCase()
  // Typed exactly as it reads is still the best answer there is.
  if (h.includes(needle.trim().toLowerCase())) return fuzzyScore(haystack, needle.trim())
  let score = 0
  const positions = new Set<number>()
  for (const w of words) {
    if (!h.includes(w.toLowerCase())) return null
    const r = fuzzyScore(haystack, w)!
    score += r.score
    for (const p of r.positions) positions.add(p)
  }
  return { score: score / words.length, positions: [...positions].sort((a, b) => a - b) }
}

export function fuzzyFilter<T>(items: T[], needle: string, key: (t: T) => string, limit = 40): Scored<T>[] {
  const out: Scored<T>[] = []
  for (const item of items) {
    const r = fuzzyMatch(key(item), needle)
    if (r) out.push({ item, score: r.score, positions: r.positions })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

/** Splits a label into matched / unmatched runs for highlighting. */
export function highlight(text: string, positions: number[]): { text: string; hit: boolean }[] {
  if (!positions.length) return [{ text, hit: false }]
  const set = new Set(positions)
  const parts: { text: string; hit: boolean }[] = []
  let cur = ''
  let curHit = set.has(0)
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    if (hit !== curHit) {
      if (cur) parts.push({ text: cur, hit: curHit })
      cur = ''
      curHit = hit
    }
    cur += text[i]
  }
  if (cur) parts.push({ text: cur, hit: curHit })
  return parts
}
