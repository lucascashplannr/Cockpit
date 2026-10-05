import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { newId } from '@cockpit/shared'
import { loadConfig } from './config.js'
import { getProject, requireWorkspace } from './registry.js'
import { append } from './journal.js'
import { integrationEnv, recorder, scan } from './terminalHistory.js'

/**
 * §2 — "Il en embarque un, indispensable comme porte de sortie. Il ne remplace
 * pas le shell configuré." So: a real TTY, the user's own shell, their profile.
 * §14 — node-pty, because agent CLIs demand a genuine TTY.
 */

const require = createRequire(import.meta.url)

interface IPty {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pid: number
}

interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPty
}

let ptyModule: PtyModule | null = null
let ptyError: string | null = null

function loadPty(): PtyModule | null {
  if (ptyModule || ptyError) return ptyModule
  try {
    ptyModule = require('node-pty') as PtyModule
  } catch (e) {
    ptyError = String(e)
  }
  return ptyModule
}

export const termBus = new EventEmitter<{
  data: [{ termId: string; data: string }]
  exit: [{ termId: string; code: number }]
}>()
termBus.setMaxListeners(200)

interface Session {
  id: string
  pty: IPty
  /** Null for a shell at a project's root: it is in no one checkout. */
  workspaceId: string | null
  /** Replayed on reconnect, so closing the window does not lose scrollback. */
  scrollback: string[]
}

const sessions = new Map<string, Session>()
const SCROLLBACK_MAX = 400

function defaultShell(): string {
  const cfg = loadConfig()
  if (cfg.shell) return cfg.shell
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe'
  return process.env.SHELL ?? '/bin/zsh'
}

/** Where a shell opens: one checkout, or the root folder of a project. */
export type TerminalTarget = { workspaceId?: string; projectId?: string }

export function open(target: TerminalTarget, cols: number, rows: number, shell?: string): string {
  const mod = loadPty()
  if (!mod) throw new Error('node-pty unavailable: ' + ptyError)

  // §7 — the project's root is where a project-wide agent's repositories sit
  // side by side; a shell there is in none of them, so its journal lines
  // belong to no workspace.
  let ws: { name: string; path: string }
  let workspaceId: string | null = null
  let projectId: string
  if (target.workspaceId) {
    const w = requireWorkspace(target.workspaceId)
    ws = w
    workspaceId = w.id
    projectId = w.projectId
  } else {
    const project = target.projectId ? getProject(target.projectId) : null
    if (!project) throw new Error('unknown project: ' + target.projectId)
    ws = { name: project.name, path: project.root }
    projectId = project.id
  }
  const id = newId('term_')
  const file = shell ?? defaultShell()

  // Login shell: the user's aliases, PATH and prompt must be there (§2).
  const p = mod.spawn(file, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: ws.path,
    env: { ...process.env, ...integrationEnv(file, process.env), COCKPIT_WORKSPACE: ws.name, TERM: 'xterm-256color' },
  })
  const history = recorder(projectId, workspaceId)

  const session: Session = { id, pty: p, workspaceId, scrollback: [] }
  sessions.set(id, session)

  p.onData((data) => {
    scan(history, data)
    session.scrollback.push(data)
    if (session.scrollback.length > SCROLLBACK_MAX) session.scrollback.shift()
    termBus.emit('data', { termId: id, data })
  })
  p.onExit(({ exitCode }) => {
    sessions.delete(id)
    termBus.emit('exit', { termId: id, code: exitCode })
    append({ type: 'terminal.closed', workspaceId, payload: { termId: id, code: exitCode } })
  })

  append({ type: 'terminal.opened', workspaceId, payload: { termId: id, shell: file, cwd: ws.path } })
  return id
}

export function write(termId: string, data: string): void {
  sessions.get(termId)?.pty.write(data)
}

export function resize(termId: string, cols: number, rows: number): void {
  try {
    sessions.get(termId)?.pty.resize(cols, rows)
  } catch {
    /* pty already gone */
  }
}

export function close(termId: string): void {
  const s = sessions.get(termId)
  if (!s) return
  try {
    s.pty.kill()
  } catch {
    /* already dead */
  }
  sessions.delete(termId)
}

export function scrollback(termId: string): string {
  return sessions.get(termId)?.scrollback.join('') ?? ''
}

export function closeAll(): void {
  for (const id of [...sessions.keys()]) close(id)
}

export function available(): boolean {
  return !!loadPty()
}
