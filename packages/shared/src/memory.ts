/**
 * §6 — the memory's shape, shared by the core that writes it, the agent that is
 * handed it and the window that shows it. One definition, so the three cannot
 * disagree about what a section is called.
 *
 * English, like everything else the window says. The first version copied the
 * spec's French headings (Objectif, Décisions, Écarté…) straight into files the
 * window then displayed; `englishMemory` converts those in place.
 */

export const MEMORY_SECTIONS = ['Goal', 'Decisions', 'Contracts', 'Constraints', 'Ruled out', 'State'] as const
export type MemorySection = (typeof MEMORY_SECTIONS)[number]

/** Replaced whole by `memory_state`, never added to — a state is true once. */
export const STATE_SECTION: MemorySection = 'State'

/**
 * "Ruled out" is the section nobody writes and that is worth the most: without
 * it every fresh conversation re-proposes what was already rejected.
 */
export const RULED_OUT_SECTION: MemorySection = 'Ruled out'

const GUIDANCE: Partial<Record<MemorySection, string>> = {
  Decisions: '_(what was settled, and why)_',
  Contracts: '_(what other code relies on — endpoints, payloads, events, files — and where it lives)_',
  Constraints: '_(what must not break)_',
  'Ruled out': '_(approaches dropped, and why — so no fresh conversation re-proposes them)_',
}

/** A new memory: every heading, with a line under each that says what goes there. */
export function memoryTemplate(title?: string): string {
  const out: string[] = title ? ['# ' + title, ''] : []
  for (const s of MEMORY_SECTIONS) {
    out.push('## ' + s)
    const g = GUIDANCE[s]
    if (g) out.push(g)
    out.push('')
  }
  return out.join('\n')
}

const FRENCH: Record<string, MemorySection> = {
  Objectif: 'Goal',
  Décisions: 'Decisions',
  Contrats: 'Contracts',
  Contraintes: 'Constraints',
  Écarté: 'Ruled out',
  État: 'State',
}

/** The French templates' guidance, exactly as they were written, and what replaces it. */
const FRENCH_GUIDANCE: [string, string][] = [
  ['_(ce qui a été tranché, et pourquoi)_', GUIDANCE.Decisions!],
  [
    "_(ce que d'autres parties du code attendent : endpoints, payloads,\névénements, fichiers — et où ça vit)_",
    GUIDANCE.Contracts!,
  ],
  ["_(ce qu'il ne faut pas casser)_", GUIDANCE.Constraints!],
  [
    '_(la section la plus précieuse : sans elle, chaque session fraîche\nrepropose la solution déjà rejetée pour une bonne raison)_',
    GUIDANCE['Ruled out']!,
  ],
]

/**
 * A memory written by an earlier build, in English: its headings renamed and
 * the template's own guidance swapped. Only those — what anyone wrote under
 * them stays exactly as written.
 */
export function englishMemory(content: string): string {
  // `[ \t]*`, not `\s*`: under the multiline flag `\s` crosses the newline and
  // takes the blank line after the heading with it.
  let out = content.replace(/^##[ \t]+(.+?)[ \t]*$/gm, (line, title: string) => {
    const en = FRENCH[title.trim()]
    return en ? '## ' + en : line
  })
  for (const [fr, en] of FRENCH_GUIDANCE) out = out.split(fr).join(en)
  return out
}

/**
 * Whether anything is written in it beyond the template. Headings and the
 * guidance under them are the form, not the content — an empty form is not a
 * memory, and handing one to the engine is a paragraph that says nothing.
 */
export function hasMemoryEntries(content: string): boolean {
  return content
    .replace(/^#{1,2}\s.*$/gm, '')
    .replace(/^_\([\s\S]*?\)_$/gm, '')
    .trim().length > 0
}

/** The section as the template spells it, from any case, accents, or the old French name. */
export function canonicalSection(section: string): string {
  const t = section.trim()
  if (FRENCH[t]) return FRENCH[t]
  const key = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const fr = Object.keys(FRENCH).find((k) => key(k) === key(t))
  if (fr) return FRENCH[fr]!
  return MEMORY_SECTIONS.find((s) => key(s) === key(t)) ?? t
}
