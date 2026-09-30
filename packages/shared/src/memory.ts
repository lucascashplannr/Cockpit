/**
 * §6 — the memory's shape, shared by the core that writes it, the agent that is
 * handed it and the window that shows it. One definition, so the three cannot
 * disagree about what a section is called.
 *
 * English, like everything else the window says. The first version copied the
 * spec's French headings (Objectif, Décisions, Écarté…) straight into files the
 * window then displayed; `englishMemory` converts those in place.
 */

/**
 * In the order a fresh conversation needs them: what this is for, where it
 * stands and what is waiting on a person — then what is settled, relied on,
 * guarded and rejected. State and Open questions were once last or absent,
 * and they are the first thing a handoff has to say.
 */
export const MEMORY_SECTIONS = [
  'Goal', 'State', 'Open questions', 'Decisions', 'Contracts', 'Constraints', 'Ruled out',
] as const
export type MemorySection = (typeof MEMORY_SECTIONS)[number]

/**
 * Whose memory it is. A topic's and a named one are each one piece of work, so
 * they have a Goal; the project's old single memory has no single goal.
 */
export type MemoryKind = 'topic' | 'named' | 'project'

export function sectionsFor(kind: MemoryKind): readonly MemorySection[] {
  return kind === 'project' ? MEMORY_SECTIONS.filter((s) => s !== 'Goal') : MEMORY_SECTIONS
}

/**
 * What a conversation's memory is, as stored on it:
 * - `off`   — none: no memory tools, nothing read, nothing written
 * - `new`   — one is created, named after the conversation, the first time the
 *             agent writes something down; until then there is nothing to read
 * - `topic:<id>`, `project`, or a named memory's id — that one
 */
export type MemoryChoice = string
export const MEMORY_OFF = 'off'
export const MEMORY_NEW = 'new'
export const PROJECT_MEMORY = 'project'

export function topicMemoryId(topicId: string): string {
  return 'topic:' + topicId
}

/** Undecided, and waiting on a person — the part of a handoff most easily lost. */
export const OPEN_QUESTIONS_SECTION: MemorySection = 'Open questions'

/** Replaced whole by `memory_state`, never added to — a state is true once. */
export const STATE_SECTION: MemorySection = 'State'

/**
 * "Ruled out" is the section nobody writes and that is worth the most: without
 * it every fresh conversation re-proposes what was already rejected.
 */
export const RULED_OUT_SECTION: MemorySection = 'Ruled out'

const GUIDANCE: Partial<Record<MemorySection, string>> = {
  Goal: '_(what this work is for)_',
  State: '_(done, in progress, next)_',
  'Open questions': '_(undecided and waiting on a person — and what hangs on each)_',
  Decisions: '_(what was settled, and why)_',
  Contracts: '_(what other code relies on — endpoints, payloads, events, files — and where it lives)_',
  Constraints: '_(what must not break)_',
  'Ruled out': '_(approaches dropped, and why — so no fresh conversation re-proposes them)_',
}

/** A new memory: every heading, with a line under each that says what goes there. */
export function memoryTemplate(kind: MemoryKind, title?: string): string {
  const out: string[] = title ? ['# ' + title, ''] : []
  for (const s of sectionsFor(kind)) {
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

/**
 * A memory in the current shape: its sections in `MEMORY_SECTIONS` order, the
 * ones it lacks added empty with their guidance, and any section of its own
 * kept, in its own order, after them. What is written under a heading moves
 * with it and is never changed. A project's Goal goes only when nothing is in it.
 */
export function shapedMemory(content: string, kind: MemoryKind): string {
  const lines = content.split('\n')
  const first = lines.findIndex((l) => /^##[ \t]+/.test(l))
  const head = (first === -1 ? lines : lines.slice(0, first)).join('\n').replace(/\s+$/, '')
  const bodies = new Map<string, string>()
  const own: string[] = []
  if (first !== -1) {
    let title = ''
    let body: string[] = []
    const keep = () => {
      if (!title) return
      const key = canonicalSection(title)
      if (bodies.has(key)) bodies.set(key, bodies.get(key) + '\n' + body.join('\n'))
      else {
        bodies.set(key, body.join('\n'))
        if (!(MEMORY_SECTIONS as readonly string[]).includes(key)) own.push(key)
      }
    }
    for (const l of lines.slice(first)) {
      const h = /^##[ \t]+(.+?)[ \t]*$/.exec(l)
      if (h) {
        keep()
        title = h[1]!
        body = []
      } else body.push(l)
    }
    keep()
  }
  const out: string[] = head ? [head, ''] : []
  const put = (title: string, body: string) => {
    const b = body.replace(/^\s*\n/, '').replace(/\s+$/, '')
    out.push('## ' + title, ...(b ? [b] : []), '')
  }
  for (const s of MEMORY_SECTIONS) {
    const body = bodies.get(s)
    if (s === 'Goal' && kind === 'project' && !(body && hasMemoryEntries(body))) continue
    put(s, body?.trim() ? body : (GUIDANCE[s] ?? ''))
  }
  for (const t of own) put(t, bodies.get(t) ?? '')
  return out.join('\n')
}
