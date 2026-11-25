/**
 * §16 — the house style for commit messages, set once in Settings and followed
 * by Draft in every repository.
 *
 * Structured rather than a paragraph: each rule is one control, so the sheet
 * reads as a form instead of an essay, and the parts that can be checked
 * without a model (a ticket number, an emoji) are checked without one.
 */

/** The Conventional Commits prefixes, in the order the sheet shows them. */
export const COMMIT_TYPES = [
  'feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert',
] as const

export interface CommitRules {
  /** Off: no house style — Draft follows the repository's own log. */
  on: boolean
  /** The prefixes a subject may start with. */
  types: string[]
  /** `type(scope): …`, `type(scope)?: …`, or `type: …`. */
  scope: 'required' | 'optional' | 'none'
  /** At most this many sentences, on one line. */
  sentences: 1 | 2
  language: string
  noTickets: boolean
  noEmoji: boolean
  /** Anything the controls do not say, one rule per line. */
  extra: string
}

export const COMMIT_RULES_DEFAULTS: CommitRules = {
  on: false,
  types: [...COMMIT_TYPES],
  scope: 'required',
  sentences: 2,
  language: 'English',
  noTickets: true,
  noEmoji: true,
  extra: '',
}

/**
 * Whatever arrives — an older config, a partial patch, a field from a newer
 * window — comes out as a complete, valid set. A string is the first shape this
 * setting had (one free-text box) and is read as its extra lines.
 */
export function normalizeCommitRules(raw: unknown): CommitRules {
  const d = COMMIT_RULES_DEFAULTS
  if (typeof raw === 'string') {
    return raw.trim() ? { ...d, on: true, extra: raw.trim() } : { ...d }
  }
  if (!raw || typeof raw !== 'object') return { ...d, types: [...d.types] }
  const r = raw as Partial<CommitRules>
  const types = Array.isArray(r.types)
    ? [...new Set(r.types.map((t) => String(t).trim().toLowerCase()).filter((t) => /^[a-z][a-z0-9-]*$/.test(t)))]
    : [...d.types]
  return {
    on: typeof r.on === 'boolean' ? r.on : d.on,
    types: types.length ? types : [...d.types],
    scope: r.scope === 'optional' || r.scope === 'none' ? r.scope : 'required',
    sentences: r.sentences === 1 ? 1 : 2,
    language: typeof r.language === 'string' && r.language.trim() ? r.language.trim() : d.language,
    noTickets: typeof r.noTickets === 'boolean' ? r.noTickets : d.noTickets,
    noEmoji: typeof r.noEmoji === 'boolean' ? r.noEmoji : d.noEmoji,
    extra: typeof r.extra === 'string' ? r.extra.trim() : '',
  }
}

/** The subject's shape, as it would be written: `type(scope): subject`. */
export function commitFormat(r: CommitRules): string {
  return r.scope === 'required' ? 'type(scope): subject'
    : r.scope === 'optional' ? 'type(scope): subject — or type: subject'
      : 'type: subject'
}

/**
 * The whole message's length, in characters. "Two sentences" alone let a draft
 * run to 400 characters of clauses joined by "and", plus an "It also…" for
 * everything else the diff touched: two sentences, as written, and unreadable
 * in a log.
 */
export function commitMax(r: CommitRules): number {
  return r.sentences === 1 ? 72 : 100
}

/** The rules as the drafter reads them, one line each. Empty when off. */
export function commitRuleLines(r: CommitRules): string[] {
  if (!r.on) return []
  const max = commitMax(r)
  return [
    'Format: ' + commitFormat(r),
    'type is one of: ' + r.types.join(', '),
    ...(r.scope === 'none' ? [] : ['scope: the area changed, one lowercase word (core, diff, settings…)']),
    'subject: ' + r.language + ', imperative ("add", not "added"), lowercase start, no trailing period',
    r.sentences === 1
      ? 'One sentence, on one line, at most ' + max + ' characters in all'
      : 'One or two short sentences, on one line, at most ' + max + ' characters in all',
    'Name the main change only. Leave the side changes out: no "It also", no list of everything the diff touches',
    ...(r.noTickets ? ['No ticket or PR numbers such as (#123)'] : []),
    ...(r.noEmoji ? ['No emoji'] : []),
    ...r.extra.split('\n').map((l) => l.trim()).filter(Boolean),
  ]
}

/**
 * The rules an agent's proposed message follows (`AgentWrap.git`): the house
 * style when there is one, Draft's own one-line format otherwise. Said to the
 * agent, and checked by `commitMessageProblems` before the card shows it.
 */
export function agentCommitRules(r: CommitRules): string[] {
  const house = commitRuleLines(r)
  return [
    ...(house.length
      ? house
      : ['One line, imperative, concrete, at most ' + PLAIN_SUBJECT_MAX + ' characters, in the convention of the repository\'s recent log']),
    'One line only: no body',
    'No Co-Authored-By, Signed-off-by or any other trailer line',
  ]
}

const PLAIN_SUBJECT_MAX = 72

/**
 * What can be checked without a model, each as a short reason. Empty when the
 * message passes. A typed message in the commit box is never checked: this is
 * for the agent, which has the engine's own habits (a body, a co-author line)
 * pulling the other way.
 */
export function commitMessageProblems(message: string, r: CommitRules): string[] {
  const out: string[] = []
  const m = message.trim()
  if (/^\s*(co-authored-by|signed-off-by|reviewed-by|generated with)\b/im.test(m) || /🤖/u.test(m)) {
    out.push('it has a co-author or other trailer line')
  }
  if (/\n/.test(m)) out.push('it is more than one line')
  const subject = m.split('\n')[0]!.trim()
  if (!r.on) {
    if (subject.length > PLAIN_SUBJECT_MAX) out.push('it is longer than ' + PLAIN_SUBJECT_MAX + ' characters')
    return out
  }
  const shape =
    r.scope === 'required' ? /^([a-z][a-z0-9-]*)\([^()\s]+\): \S/
      : r.scope === 'optional' ? /^([a-z][a-z0-9-]*)(\([^()\s]+\))?: \S/
        : /^([a-z][a-z0-9-]*): \S/
  const hit = shape.exec(subject)
  if (!hit) out.push('it is not in the form ' + commitFormat(r))
  else if (!r.types.includes(hit[1]!)) out.push(hit[1] + ' is not one of the types (' + r.types.join(', ') + ')')
  if (subject.length > commitMax(r)) out.push('it is ' + subject.length + ' characters, the limit is ' + commitMax(r))
  if (r.noTickets && /\(#\d+\)|(^|\s)#\d+\b/.test(m)) out.push('it has a ticket or PR number')
  if (r.noEmoji && /\p{Extended_Pictographic}/u.test(m)) out.push('it has an emoji')
  return out
}
