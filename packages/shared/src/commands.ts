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
