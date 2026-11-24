import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COCKPIT_HOME, ensureHome } from './config.js'

/**
 * Said to the agent at the moment it tries git itself.
 *
 * The rule is in its system prompt, and Opus still reached for `git add &&
 * git commit` on "Can you commit?", out of habit: the engine's own prompt
 * teaches it to. Refused by the deny rule alone, it read a bare "Permission
 * … has been denied", gave up, and told the person to run it by hand. The
 * refusal is the one thing it always reads, so the refusal says what to do.
 */
export const REFUSAL =
  'Not run: in Cockpit you never stage, commit or push from the shell. If the person asked for it, ' +
  'put it in mcp__cockpit__wrap_up as `git` (files, a commit message, push when they said push), ' +
  'and Cockpit shows it as a button and runs it when they press it. ' +
  'Do not try another way and do not tell them to run it themselves; say it is ready on the card.'

/**
 * A `PreToolUse` hook that refuses a shell `git add`, `git commit` or `git push`
 * with `REFUSAL`. Hooks run before the permission rules, so the agent hears
 * this sentence; `DEFAULT_DENY` stays behind it as the wall, for a command the
 * pattern misses. Plain `sh`, `sed` and `grep`, written into Cockpit's home: a
 * packaged app has no `node` on its PATH to give it.
 */
export function refusalHook(): string {
  ensureHome()
  const dir = join(COCKPIT_HOME, 'hooks')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'git-refusal.sh')
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFUSAL },
  })
  if (out.includes("'")) throw new Error('the refusal cannot hold a single quote')
  const script = [
    '#!/bin/sh',
    '# Written by Cockpit (core gitHook.ts) at every launch; edits do not last.',
    // The command as JSON-escaped text: a newline in it is the two characters \n.
    "cmd=$(sed -E 's/.*\"command\":\"(([^\"\\\\]|\\\\.)*)\".*/\\1/')",
    // `git` at the start of a command (after ; & | ( { $( ` or an escaped newline),
    // its own options (-C dir, -c k=v, --no-pager), then add / commit / push / stage.
    "if printf '%s' \"$cmd\" | grep -Eq '(^|[;&|({]|\\\\n|\\$\\(|`)[[:space:]]*(sudo[[:space:]]+)?git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(add|commit|push|stage)([^[:alnum:]_-]|$)'; then",
    "  printf '%s' '" + out + "'",
    'fi',
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return file
}
