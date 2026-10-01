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
  /**
   * The line from something that is not a commit yet — the uncommitted work
   * drawn above HEAD — down to the commit it would follow. Drawn dashed all
   * the way, however many rows it has to cross to reach it.
   */
  dashed?: boolean
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
  commits: readonly { hash: string; parents: readonly string[]; virtual?: boolean }[],
  head: string | null,
): { rows: LaidRow[]; width: number } {
  // The first-parent chain from HEAD, as far as this page reaches.
  const chain = new Set<string>()
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  for (let h = head; h && !chain.has(h); h = byHash.get(h)?.parents[0] ?? null) chain.add(h)

  const lanes: (string | null)[] = []
  const colors: number[] = []
  /** The lane is carrying a virtual commit's edge, not a real one. */
  const pending: boolean[] = []
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
    // Several lanes can be waiting for one commit. HEAD's chain takes its own
    // (the accent one) when it is among them, so the line you are on never
    // steps sideways to land on a commit another branch reached first.
    let lane = lanes.indexOf(c.hash)
    if (chain.has(c.hash)) {
      const own = lanes.findIndex((h, j) => h === c.hash && colors[j] === 0)
      if (own !== -1) lane = own
    }
    const into: Stroke[] = []
    const through: Stroke[] = []
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === null) continue
      const s = { lane: j, color: colors[j]!, dashed: pending[j] }
      if (lanes[j] === c.hash) into.push(s)
      else through.push(s)
    }
    if (lane === -1) {
      // Nothing was waiting for it: a branch tip. It starts here, in the first
      // free slot, and no line comes down into it.
      lane = free()
      colors[lane] = colorFor(c.hash, fresh)
    }
    const color = colorFor(c.hash, () => colors[lane]!)
    colors[lane] = color
    for (const s of into) {
      lanes[s.lane] = null
      pending[s.lane] = false
    }
    const dashed = !!c.virtual

    const out: Stroke[] = []
    c.parents.forEach((p, i) => {
      const k = lanes.indexOf(p)
      // On the chain, the first parent stays in this lane even when another
      // lane already waits for it: both run down and meet at it, rather than
      // HEAD's line bending over into a branch that got there first.
      if (k !== -1 && !(i === 0 && color === 0)) {
        // Already awaited in another lane — the line curves into it in this
        // commit's colour, the way a branch is drawn rejoining the one it left.
        out.push({ lane: k, color, dashed })
      } else if (i === 0) {
        lanes[lane] = p
        pending[lane] = dashed
        // HEAD's line stays HEAD's line past the end of the page, where the
        // chain can no longer be walked to prove it.
        colors[lane] = color
        out.push({ lane, color: colors[lane]!, dashed })
      } else {
        const f = free()
        lanes[f] = p
        pending[f] = dashed
        colors[f] = colorFor(p, fresh)
        out.push({ lane: f, color: colors[f]!, dashed })
      }
    })

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const below: Stroke[] = []
    lanes.forEach((h, j) => {
      if (h !== null) below.push({ lane: j, color: colors[j]!, dashed: pending[j] })
    })

    width = Math.max(width, lane + 1, ...into.map((s) => s.lane + 1), ...through.map((s) => s.lane + 1), ...out.map((s) => s.lane + 1))
    rows.push({ lane, color, through, into, out, below })
  }

  return { rows, width }
}
