import type { PermissionMode } from '@cockpit/shared'

/**
 * What went through without a question only because of the mode.
 *
 * The engine does not say. In Auto, a call its classifier approved arrives
 * exactly like one that never needed approving — the same `tool_use`, the same
 * result, nothing on either — so the only way to know is to ask the question
 * Manual would have asked and notice that nobody asked it.
 *
 * An estimate of the engine's own rules, and a conservative one: an unfamiliar
 * command counts as one Manual would have asked about, because the mark exists
 * to show what slipped past, and missing one is the worse mistake. What it does
 * not know about is a person's own allow rules in `.claude/settings.json`,
 * which would have let a call through in Manual too — there are none today.
 */

/** Modes in which a call can run that Manual would have stopped. */
const WAVES_THROUGH: ReadonlySet<PermissionMode> = new Set(['auto', 'acceptEdits', 'bypassPermissions'])

/** Tools Manual asks about every time. */
const ALWAYS_ASKS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch'])

/** Commands that only look, which Manual lets run without a word. */
const LOOKS_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'tree', 'file', 'stat', 'du', 'df', 'which', 'whereis', 'type', 'command', 'date', 'whoami',
  'uname', 'hostname', 'id', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'jq', 'basename', 'dirname',
  'realpath', 'readlink', 'nl', 'column', 'true', 'false', 'test', '[', 'cd', 'fd',
])

/** `git` subcommands that read the repository and change nothing. */
const GIT_LOOKS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog',
  'reflog', 'grep', 'cat-file', 'ls-tree', 'merge-base', 'name-rev', 'whatchanged', 'rev-list',
])

/**
 * The mode a call ran under without being asked, when Manual would have asked
 * about it; null when it was asked, or would not have been.
 */
export function ranUnasked(
  tool: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  asked: boolean,
): PermissionMode | null {
  if (asked || !WAVES_THROUGH.has(mode)) return null
  return manualAsks(tool, input) ? mode : null
}

function manualAsks(tool: string, input: Record<string, unknown>): boolean {
  if (ALWAYS_ASKS.has(tool) || tool.startsWith('mcp__')) return true
  if (tool !== 'Bash') return false
  const command = typeof input.command === 'string' ? input.command : ''
  return !looksOnly(command)
}

/** Every part of the command only reads. Anything unrecognised writes. */
function looksOnly(command: string): boolean {
  // A redirect into a file is a write whatever the command in front of it is;
  // into /dev/null, or one stream into another, it is not.
  const unredirected = command.replace(/\d?>>?\s*\/dev\/null|\d?>&\d/g, '')
  if (/>/.test(unredirected)) return false
  const parts = unredirected.split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(partLooksOnly)
}

function partLooksOnly(part: string): boolean {
  // `FOO=1 cmd` is `cmd`.
  const words = part.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const [cmd, ...args] = words
  if (!cmd) return true
  if (cmd === 'git') {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'stash') {
      // Listing them only: `git branch`, `git branch -a`, `git stash list`.
      const rest = args.slice(args.indexOf(sub) + 1)
      return sub === 'stash' ? rest[0] === 'list' : rest.every((a) => a.startsWith('-') && !/^-(d|D|m|M|f)$/.test(a))
    }
    return !!sub && GIT_LOOKS.has(sub)
  }
  if (cmd === 'sed') return !args.some((a) => /^-i|^--in-place/.test(a))
  if (cmd === 'find') return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint)/.test(a))
  return LOOKS_ONLY.has(cmd)
}
