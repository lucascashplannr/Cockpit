/**
 * The commands the composer answers to — a `/word` at the start of the box.
 *
 * Three, on purpose. `claude` itself knows sixty-odd, and most of them are
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
  { name: 'clear', hint: 'New conversation on this scope', run: 'window' },
  { name: 'compact', args: 'what to keep', hint: 'Summarise the conversation to free up context', run: 'engine', thread: true },
  { name: 'init', hint: 'Write a CLAUDE.md that describes this repository', run: 'engine' },
  { name: 'document', hint: 'Propose documentation updates from this conversation', run: 'window', thread: true },
]

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
 * §6 — what `/clear` asks of a conversation before letting it go: the memory
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
  'another repository: note every decision, contract, constraint or dropped approach from this',
  'conversation that is not in it yet, then set the state (done, half-done, next, and the files that',
  'matter). Do not change any code. Reply with one short line.',
].join(' ')

export const HANDOFF_PROMPT = HANDOFF_WORDS

export function isHandoff(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.startsWith(HANDOFF_PROMPT.slice(0, 40))
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

export function documentPrompt(dir: string): string {
  return [
    DOCUMENT_WORDS + ' from what this conversation and the memory established.',
    'A working copy of the documentation is at ' + dir + ' — read its guide or index first, and follow',
    'its structure, language and conventions. Edit pages there, or add pages there; write nowhere else,',
    'and do not change any code. Only lasting knowledge belongs: how things work, contracts, decisions',
    'and their reasons, constraints. Not progress, not state, not what git already shows. If nothing',
    'deserves documenting, change nothing. Finish with one line per changed page: its path relative to',
    'the copy, an em dash, and why.',
  ].join(' ')
}

/** `/clear` with docs linked: the handoff and the proposals in one turn. */
export function handoffPrompt(docsDir: string | null): string {
  if (!docsDir) return HANDOFF_PROMPT
  return HANDOFF_PROMPT.replace(/ Reply with one short line\.$/, '') +
    ' Then, as a second step — ' + documentPrompt(docsDir).replace(DOCUMENT_WORDS, 'propose updates to the documentation')
}

export function isDocument(prompt: string | null | undefined): boolean {
  return !!prompt && prompt.startsWith(DOCUMENT_WORDS)
}
