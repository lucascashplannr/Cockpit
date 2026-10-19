/**
 * The commands the composer answers to — a `/word` at the start of the box.
 *
 * A handful, on purpose. `claude` itself knows sixty-odd, and most of them are
 * either a control this window already has in the row under the box (model,
 * effort, permissions), a figure it already shows (context, cost), or a
 * terminal's business (config, doctor, color). What is left is the handful
 * with no other door: starting over, making room, and writing the file the
 * engine reads about a repository.
 *
 * One list for both sides. The window reads it to offer and complete; the core
 * reads it to know that a turn is a command and must reach the engine exactly
 * as typed — with no topic memory in front of it and no Ultracode after it,
 * either of which turns `/compact` into a sentence that merely mentions it.
 */
export interface AgentCommand {
  /** What is typed after the `/`. */
  name: string
  /** What follows the name, when anything may — shown as a placeholder. */
  args?: string
  /** One line, in the terms of what happens rather than how. */
  hint: string
  /**
   * Who carries it out. `window` never reaches an engine; `engine` is written
   * to it verbatim, so only an engine that knows the word may be offered it.
   */
  run: 'window' | 'engine'
  /** Means nothing without a conversation behind it. */
  thread?: boolean
}

export const AGENT_COMMANDS: AgentCommand[] = [
  { name: 'clear', hint: 'Erase the memory and start a new conversation', run: 'window', thread: true },
  { name: 'next', hint: 'Bring the memory up to date, then a new conversation on it', run: 'window', thread: true },
  { name: 'compact', args: 'what to keep', hint: 'Summarise the conversation to free up context', run: 'engine', thread: true },
  { name: 'init', hint: 'Write a CLAUDE.md that describes this repository', run: 'engine' },
  { name: 'memorize', hint: 'Bring the memory up to date, and carry on here', run: 'window', thread: true },
  { name: 'document', hint: 'Propose documentation updates from this conversation', run: 'window', thread: true },
]

/**
 * Why a command that is offered here would do nothing, if it would: listed
 * all the same, so it is where it is looked for, but not run.
 *
 * `/next` and `/memorize` on a conversation with no memory have nothing to
 * write to. `/clear` with no conversation yet has nothing to clear — not
 * offered there at all (`thread`), and refused here if typed out in full.
 */
export function commandOff(name: string, empty: boolean, memory: string | null): string | null {
  if (name === 'clear' && empty) return 'Nothing to clear yet'
  if ((name === 'next' || name === 'memorize') && memory === 'off') return 'This conversation has no memory'
  return null
}

/** The engines that read `/word` as a command rather than as prose. */
export const COMMAND_ENGINES = ['claude']

/**
 * The command a prompt is, if it is one: a known name, first thing in the box,
 * followed by nothing or by a space. `/Users/…` is a path and `/compacting` is
 * a word, and both stay prose.
 */
export function commandIn(prompt: string): { command: AgentCommand; args: string } | null {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  if (!m) return null
  const command = AGENT_COMMANDS.find((c) => c.name === m[1])
  return command ? { command, args: (m[2] ?? '').trim() } : null
}

/**
 * Both ask for a rewrite toward what is true now, not for additions. Asked to
 * "note every decision not in it yet", agents logged each review round as its
 * own entries, later ones contradicting earlier ones still there, and a topic
 * memory reached 26 KB — every preamble after paying for all of it.
 */
const TIDY_WORDS = [
  'Read it first, then make it say what is true now, in as few lines as that takes:',
  'note what this conversation settled that is missing — a decision and its reason, a contract,',
  'a constraint, a dropped approach, an open question — one short line per fact; where an entry is',
  'superseded, rewrite it (`replaces`) rather than adding beside it; merge entries that say one thing',
  'twice; move to Past (`memory_outdate`, with why) what is no longer true, what is done with, and what',
  'the code or git already shows. Then set the state against the goal (done, in progress, next, and the files',
  'that matter) — not whether anything is committed or pushed, which is shown live and goes stale.',
].join(' ')

/**
 * §6 — what `/next` asks of a conversation before letting it go: the memory
 * brought up to date, so the fresh one that starts on the same scope — or an
 * agent in another repository — knows what this one knew.
 *
 * A turn of its own rather than a hidden call: it is the agent's work, it
 * costs what a turn costs, and the thread it lands in should say it happened.
 * The window draws it as a line, not as something the person typed.
 */
const HANDOFF_WORDS = [
  'Handoff: this conversation is about to be cleared, and the next one starts from the memory alone.',
  'Bring the memory up to date for whoever picks this up — the next conversation here, or an agent in',
  'another repository.',
  TIDY_WORDS,
  'Do not change any code. Reply with one short line.',
].join(' ')

export const HANDOFF_PROMPT = HANDOFF_WORDS

export function isHandoff(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.startsWith(HANDOFF_PROMPT.slice(0, 40))
}

/**
 * `/memorize` — `/next`'s note-taking without the goodbye: the memory is
 * brought up to date and the conversation carries on. For the moment something
 * is worth keeping and nothing is worth clearing — before handing a piece to an
 * agent in another repository, or ahead of a long stretch of work.
 *
 * Memory only. The docs are `/document`'s, and they pass through a person.
 */
export const MEMORIZE_PROMPT = [
  'Memorize: bring the memory up to date with this conversation so far, for whoever reads it next — a',
  'later conversation here, or an agent in another repository.',
  TIDY_WORDS,
  'Do not change any code. This conversation carries on afterwards. Reply with one short line.',
].join(' ')

export function isMemorize(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.startsWith(MEMORIZE_PROMPT.slice(0, 40))
}

/**
 * §9 — the Document step, as the turn the agent reads. `dir` is a working copy
 * of the docs: what it writes there is compared with the docs themselves and
 * becomes proposals, and nothing reaches the docs until a person accepts it.
 *
 * Lasting knowledge only. The state of the work is the memory's, and a page
 * that says "in progress" is wrong the day after it is accepted.
 */
const DOCUMENT_WORDS = 'Documentation step: propose updates to this project\'s documentation'

/** What a Document step is pointed at, when it is not the whole of the docs. */
export interface DocumentScope {
  /** The docs themselves, read there and never written there. */
  docsRoot: string
  pages: { path: string; missing: boolean; reasons: string[] }[]
  /** Lasting memory entries the docs may not say yet. */
  memory: string[]
}

export interface DocumentOptions {
  memoryCopy?: string | null
  contract?: string | null
  /**
   * §9 — only these pages: what the work changed, what an agent flagged, what
   * the memory settled. Without it, the copy is the whole of the docs.
   */
  scope?: DocumentScope | null
}

export function documentPrompt(dir: string, o: DocumentOptions = {}): string {
  const sc = o.scope
  const lines = [DOCUMENT_WORDS + ' from what this conversation and the memory established.']
  if (sc) {
    lines.push(
      'A working copy of the pages that may be out of date is at ' + dir + '. The rest of the documentation',
      'is at ' + sc.docsRoot + ' — read it there (its guide or index first) and never write there; to change',
      'another page, copy it into the working copy at the same path first.',
    )
    if (sc.pages.length) {
      lines.push('\n\nPages to check, and why:\n' + sc.pages
        .map((p) => '- ' + (p.missing ? p.path + ' (no page yet — write it only if it deserves one)' : p.path) +
          ' — ' + p.reasons.join('; '))
        .join('\n') + '\n\n')
    }
    if (sc.memory.length) {
      lines.push('\n\nSettled in the memory, which the docs may not say yet:\n' +
        sc.memory.map((m) => '- ' + m).join('\n') + '\n\n')
    }
    lines.push(
      'Bring each page up to date with what this conversation established — or leave it as it is when it',
      'is still right. Edit pages in the working copy, or add pages there; write nowhere else, and do not',
      'change any code.',
    )
  } else {
    lines.push(
      'A working copy of the documentation is at ' + dir + ' — read its guide or index first, and follow',
      'its structure, language and conventions. Edit pages there, or add pages there; write nowhere else,',
      'and do not change any code.',
    )
  }
  lines.push(
    'Only lasting knowledge belongs: how things work, contracts, decisions and their reasons, constraints.',
    'Not progress, not state, not what git already shows. If nothing deserves documenting, change nothing.',
    'Prefer changing the page that already covers a subject to adding one; a page you touch is brought up',
    'to the contract below. Finish with one line per changed page: its path relative to the copy, an em',
    'dash, and why.',
  )
  // §9 — the page contract, said again here rather than trusted to the
  // opening: a long conversation may have compacted it away.
  if (o.contract) lines.push('\n\n' + o.contract + '\n\n')
  // The memory empties into the docs: what a page now says for good, the
  // memory no longer has to carry. Deleting from a copy, so a person decides.
  if (o.memoryCopy) {
    lines.push(
      'Last, a copy of the memory is at ' + o.memoryCopy + ': delete from it the entries your pages now',
      'cover in full — only those, only whole lines, and change nothing else in it. The rest stays in the',
      'memory.',
    )
  }
  return lines.join(' ')
}

/** `/next` with docs to update: the handoff and the proposals in one turn. */
export function handoffPrompt(docsDir: string | null, o: DocumentOptions = {}): string {
  if (!docsDir) return HANDOFF_PROMPT
  return HANDOFF_PROMPT.replace(/ Reply with one\s+short line\.$/, '') +
    ' Then, as a second step — ' +
    documentPrompt(docsDir, o).replace(DOCUMENT_WORDS, 'propose updates to the documentation')
}

export function isDocument(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.startsWith(DOCUMENT_WORDS)
}
