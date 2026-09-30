/**
 * A page before and after, as lines — for the Docs tool, where the proposal is
 * two whole texts and not a patch. A longest-common-subsequence walk: pages are
 * short, and past a size where the table would be the cost, the answer is the
 * honest one — the page was rewritten.
 */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'gap'
  text: string
}

const CELLS_MAX = 4_000_000
const CONTEXT = 3

export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = before === null ? [] : before.split('\n')
  const b = after === null ? [] : after.split('\n')
  if (a.length * b.length > CELLS_MAX) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  }
  const n = a.length
  const m = b.length
  // lcs[i][j]: the common run of a[i..] and b[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] = a[i] === b[j] ? lcs[at(i + 1, j + 1)]! + 1 : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if (lcs[at(i + 1, j)]! >= lcs[at(i, j + 1)]!) out.push({ kind: 'del', text: a[i++]! })
    else out.push({ kind: 'add', text: b[j++]! })
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return fold(out)
}

/** Unchanged stretches kept to a few lines either side of a change. */
function fold(lines: DiffLine[]): DiffLine[] {
  const near = lines.map(() => false)
  lines.forEach((l, k) => {
    if (l.kind === 'ctx') return
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (lines[k + d]) near[k + d] = true
  })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((l, k) => {
    if (near[k]) {
      if (skipped) out.push({ kind: 'gap', text: skipped + ' unchanged lines' })
      skipped = 0
      out.push(l)
    } else skipped++
  })
  if (skipped && out.length) out.push({ kind: 'gap', text: skipped + ' unchanged lines' })
  return out
}
