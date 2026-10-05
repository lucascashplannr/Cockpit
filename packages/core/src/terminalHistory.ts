import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TerminalCommand } from '@cockpit/shared'
import { ensureHome } from './config.js'
import { getDb } from './db.js'

/**
 * What was typed into the terminal tab, kept.
 *
 * The scrollback is the wrong place to look for it: Clear empties it, a
 * restart empties it, and closing the window ends the shell that held it. The
 * shell's own history file is the wrong place too — it is every terminal on
 * the machine, in whatever project, and zsh only writes it on exit unless
 * told otherwise. So the shell is asked to say what it is about to run, and
 * the core writes that down against the project it was run in.
 *
 * Asked, not guessed. The keystrokes going to the pty are not the command: a
 * Tab, an ↑ or a ^R makes the line something nobody typed. `preexec` is handed
 * the line as the shell accepted it, and `precmd` how it ended.
 */

/** A private OSC. xterm drops a sequence it has no handler for, so nothing is drawn. */
const MARK = '\x1b]7717;'
const END = '\x07'
/** A command longer than this is a paste gone wrong, not something to offer again. */
const CARRY_MAX = 64 * 1024

/**
 * The whole integration, as the one file zsh reads first.
 *
 * `ZDOTDIR` is pointed here for exactly as long as it takes to read this:
 * the first thing it does is put the user's own back, so every other startup
 * file — theirs, in their order, with their `HISTFILE` — is found where it
 * always was. The hooks go on the `*_functions` arrays, which is where
 * `add-zsh-hook` puts them too, so a framework loaded later appends to them
 * rather than replacing them.
 *
 * A line starting with a space is not reported: that is how one keeps a
 * command out of a history, and it should work on this one as well.
 */
const ZSHENV = String.raw`# Written by Cockpit; rewritten on every terminal it opens.
if [[ -n "\${COCKPIT_USER_ZDOTDIR+x}" ]]; then
  export ZDOTDIR="$COCKPIT_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset COCKPIT_USER_ZDOTDIR
[[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]] && builtin source "\${ZDOTDIR:-$HOME}/.zshenv"

if [[ -o interactive ]]; then
  __cockpit_preexec() {
    builtin local c="\${1:-$3}"
    [[ -z "$c" || "$c" == ' '* ]] && builtin return
    c="\${c//\\/\\\\}"
    c="\${c//$'\n'/\\n}"
    c="\${c//$'\e'/}"
    c="\${c//$'\a'/}"
    builtin print -rn -- $'\e]7717;C;'"$c"$'\a'
  }
  __cockpit_precmd() {
    builtin local s=$?
    builtin print -rn -- $'\e]7717;D;'"$s"$'\a'
  }
  builtin typeset -ga preexec_functions precmd_functions
  preexec_functions+=(__cockpit_preexec)
  precmd_functions=(__cockpit_precmd $precmd_functions)
fi
`.replace(/\\\$\{/g, '${')

/**
 * The environment that makes `shell` report its commands, or nothing when it
 * is a shell this does not know how to ask. Only zsh, for now: bash has no
 * `preexec`, and a history that misses commands is worse than none.
 */
export function integrationEnv(shell: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (basename(shell) !== 'zsh') return {}
  try {
    const dir = join(ensureHome(), 'shell', 'zsh')
    const file = join(dir, '.zshenv')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== ZSHENV) writeFileSync(file, ZSHENV)
    return { ZDOTDIR: dir, ...(env.ZDOTDIR !== undefined ? { COCKPIT_USER_ZDOTDIR: env.ZDOTDIR } : {}) }
  } catch {
    // A home that cannot be written to still gets a shell, just an unrecorded one.
    return {}
  }
}

/** What a shell's reports are read against: where it runs, and what is still running. */
export interface Recorder {
  projectId: string
  workspaceId: string | null
  /** A report cut in two by a chunk boundary, waiting for its other half. */
  carry: string
  /** The row of the command that has not ended yet. */
  running: number | null
}

export function recorder(projectId: string, workspaceId: string | null): Recorder {
  return { projectId, workspaceId, carry: '', running: null }
}

/** Reads the shell's reports out of what it wrote. The data itself is not touched. */
export function scan(r: Recorder, data: string): void {
  let buf = r.carry + data
  r.carry = ''
  for (;;) {
    const at = buf.indexOf(MARK)
    if (at === -1) break
    const end = buf.indexOf(END, at)
    if (end === -1) {
      if (buf.length - at < CARRY_MAX) r.carry = buf.slice(at)
      return
    }
    report(r, buf.slice(at + MARK.length, end))
    buf = buf.slice(end + 1)
  }
  // The mark itself may be what was cut.
  for (let n = Math.min(MARK.length - 1, buf.length); n > 0; n--) {
    if (MARK.startsWith(buf.slice(-n))) {
      r.carry = buf.slice(-n)
      break
    }
  }
}

function report(r: Recorder, body: string): void {
  const kind = body.slice(0, 2)
  const rest = body.slice(2)
  try {
    if (kind === 'C;') {
      const command = rest.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)).trim()
      if (!command) return
      const res = getDb()
        .prepare('INSERT INTO terminal_history (ts, project_id, workspace_id, command) VALUES (?, ?, ?, ?)')
        .run(Date.now(), r.projectId, r.workspaceId, command)
      r.running = Number(res.lastInsertRowid)
    } else if (kind === 'D;' && r.running !== null) {
      const code = Number(rest)
      if (Number.isInteger(code)) {
        getDb().prepare('UPDATE terminal_history SET exit_code = ? WHERE id = ?').run(code, r.running)
      }
      r.running = null
    }
  } catch {
    /* a history that cannot be written must never take the shell with it */
  }
}

/**
 * The project's commands, each once, the latest run of each first.
 *
 * Once, because a history is searched for a command and not for an occasion:
 * forty `pnpm dev` in a row are one thing to find. The count says it was
 * forty.
 */
export function list(projectId: string, q?: string, limit = 200): TerminalCommand[] {
  const needle = (q ?? '').trim()
  const like = '%' + needle.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  // SQLite's bare-column rule: with a single MAX() the other columns are read
  // from the row that holds it, so the exit code is the latest run's.
  const rows = getDb()
    .prepare(
      `SELECT command, MAX(id) AS id, ts, exit_code AS exitCode, workspace_id AS workspaceId, COUNT(*) AS count
         FROM terminal_history
        WHERE project_id = ? AND command LIKE ? ESCAPE '\\'
        GROUP BY command
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(projectId, like, Math.max(1, Math.min(limit, 1000))) as (TerminalCommand & { id: number })[]
  return rows.map(({ id: _id, ...row }) => row)
}

/** Every run of one command — or, with none named, the project's whole history. */
export function forget(projectId: string, command?: string): number {
  const d = getDb()
  const res =
    command === undefined
      ? d.prepare('DELETE FROM terminal_history WHERE project_id = ?').run(projectId)
      : d.prepare('DELETE FROM terminal_history WHERE project_id = ? AND command = ?').run(projectId, command)
  return res.changes
}
