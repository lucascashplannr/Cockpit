/**
 * The lanes of the Commits graph — where each commit's dot sits, and the lines
 * that run past it, into it and out of it.
 *
 * One pass, newest first, over commits git has already put in an order where a
 * child always comes before its parents (`--date-order`). Each lane holds the
 * hash it is waiting for; a commit takes the lane that was waiting for it, and
 * hands that lane on to its first parent. Lanes never move sideways once
 * given: a line that shifted a column every time another one ended is a line
 * the eye cannot follow, and a free slot is simply reused by the next branch.
 *
 * Colour 0 is the first-parent chain from HEAD — "this branch" — and it is the
 * only line drawn in the accent. Every other lane gets one of the rest in
 * turn, which is only ever there to tell two lines apart.
 */

export interface Stroke {
  lane: number
  color: number
}

export interface LaidRow {
  lane: number
  color: number
  /** Lanes passing straight through, untouched by this commit. */
  through: Stroke[]
  /** Lanes arriving from above that end at this commit (its own included). */
  into: Stroke[]
  /** Lanes leaving this commit for its parents (its own included). */
  out: Stroke[]
  /** Every lane alive under this row — the gutter of an opened commit. */
  below: Stroke[]
}

export const LANE_COLORS = 6

export function layout(
  commits: readonly { hash: string; parents: readonly string[] }[],
  head: string | null,
): { rows: LaidRow[]; width: number } {
  // The first-parent chain from HEAD, as far as this page reaches.
  const chain = new Set<string>()
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  for (let h = head; h && !chain.has(h); h = byHash.get(h)?.parents[0] ?? null) chain.add(h)

  const lanes: (string | null)[] = []
  const colors: number[] = []
  let next = 0
  const fresh = () => 1 + (next++ % (LANE_COLORS - 1))
  const colorFor = (hash: string, fallback: () => number) => (chain.has(hash) ? 0 : fallback())
  const free = () => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.length : i
  }

  const rows: LaidRow[] = []
  let width = 0

  for (const c of commits) {
    let lane = lanes.indexOf(c.hash)
    const into: Stroke[] = []
    const through: Stroke[] = []
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === null) continue
      if (lanes[j] === c.hash) into.push({ lane: j, color: colors[j]! })
      else through.push({ lane: j, color: colors[j]! })
    }
    if (lane === -1) {
      // Nothing was waiting for it: a branch tip. It starts here, in the first
      // free slot, and no line comes down into it.
      lane = free()
      colors[lane] = colorFor(c.hash, fresh)
    }
    const color = colorFor(c.hash, () => colors[lane]!)
    colors[lane] = color
    for (const s of into) lanes[s.lane] = null

    const out: Stroke[] = []
    c.parents.forEach((p, i) => {
      const k = lanes.indexOf(p)
      if (k !== -1) {
        // Already awaited in another lane — the line curves into it in this
        // commit's colour, the way a branch is drawn rejoining the one it left.
        out.push({ lane: k, color })
      } else if (i === 0) {
        lanes[lane] = p
        // HEAD's line stays HEAD's line past the end of the page, where the
        // chain can no longer be walked to prove it.
        colors[lane] = color === 0 ? 0 : colorFor(p, () => color)
        out.push({ lane, color: colors[lane]! })
      } else {
        const f = free()
        lanes[f] = p
        colors[f] = colorFor(p, fresh)
        out.push({ lane: f, color: colors[f]! })
      }
    })

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const below: Stroke[] = []
    lanes.forEach((h, j) => {
      if (h !== null) below.push({ lane: j, color: colors[j]! })
    })

    width = Math.max(width, lane + 1, ...into.map((s) => s.lane + 1), ...through.map((s) => s.lane + 1), ...out.map((s) => s.lane + 1))
    rows.push({ lane, color, through, into, out, below })
  }

  return { rows, width }
}
