/**
 * §8 — the two mechanics every declared line goes through, shared by the
 * servers that stay up and the commands that do not.
 */

export const PLACEHOLDER = /\{\{([\w.-]+)\}\}/g

/**
 * Substitution that reports what it could not do.
 *
 * An unresolved placeholder is left standing rather than replaced with an
 * empty string: `--port=` is a command that fails in a way nobody can read,
 * while `--port={{port}}` in the log says exactly which line to fix. Same rule
 * as the seed (§7) — write the truth, never a guess.
 */
export function fill(template: string, lookup: (key: string) => string | null): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = template.replace(PLACEHOLDER, (whole, key: string) => {
    const got = lookup(key)
    if (got === null) {
      missing.push(key)
      return whole
    }
    return got
  })
  return { text, missing }
}

/**
 * A command line into argv, honouring quotes.
 *
 * Deliberately not a shell: no pipes, no `&&`, no expansion. A declared server
 * is one process the supervisor owns and can kill; handing the line to `sh -c`
 * would put a shell between Cockpit and the thing it is supposed to be
 * watching, and the memory of `$(…)` in agent Bash calls is reason enough not
 * to invite a shell in where it is not needed. A line that genuinely needs one
 * can say so: `sh -c "..."` is still two arguments here.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

