import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  ok: boolean
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  input?: string
  env?: Record<string, string>
  maxBuffer?: number
  /** Windows: start the child hidden (default). GUI apps honour it too. */
  windowsHide?: boolean
  /** Aborting it stops the child; the result comes back with code 130. */
  signal?: AbortSignal
}

const IS_WIN = process.platform === 'win32'
const resolved = new Map<string, string>()

/**
 * Windows only: the file `cmd` names, found the way a shell would find it.
 *
 * Node's `spawn` does not walk PATHEXT, so `npm` — which on Windows is
 * `npm.cmd` — comes back `ENOENT` although typing it in a terminal works.
 */
function resolveWin(cmd: string): string | null {
  // Only hits are cached: a tool installed after the core started must be
  // found on the next try, not remembered as missing.
  const hit = resolved.get(cmd)
  if (hit) return hit
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExt = /\.[^\\/]+$/.test(cmd)
  const dirs = /[\\/]/.test(cmd) ? [''] : (process.env.PATH ?? process.env.Path ?? '').split(delimiter)
  let found: string | null = null
  outer: for (const dir of dirs) {
    const base = dir ? join(dir, cmd) : cmd
    for (const ext of hasExt ? ['', ...exts] : exts) {
      if (existsSync(base + ext)) {
        found = base + ext
        break outer
      }
    }
  }
  if (found) resolved.set(cmd, found)
  return found
}

/** One argument as `cmd.exe` reads it: quoted when it has to be, `"` doubled. */
function quoteCmdArg(a: string): string {
  if (a && !/[\s"&|<>^()%!,;=]/.test(a)) return a
  return '"' + a.replace(/"/g, '""') + '"'
}

/**
 * What to actually hand `spawn` for `cmd args` on this platform.
 *
 * Off Windows it is the call unchanged. On Windows the command is resolved
 * through PATHEXT, and a `.cmd` / `.bat` — which Node refuses to spawn without
 * a shell — is run through `cmd.exe /d /s /c "…"` with the line quoted here,
 * since `windowsVerbatimArguments` stops Node from re-quoting it.
 */
export function spawnable(
  cmd: string,
  args: string[],
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (!IS_WIN) return { command: cmd, args }
  const file = resolveWin(cmd)
  if (!file || /\.(exe|com)$/i.test(file)) return { command: file ?? cmd, args }
  const line = [file, ...args].map(quoteCmdArg).join(' ')
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', '"' + line + '"'],
    windowsVerbatimArguments: true,
  }
}

/**
 * §16 — "Aucun environnement de process journalisé": we pass the parent env
 * through but never write it to the journal.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const target = spawnable(cmd, args)
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: opts.windowsHide ?? true,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    }
    const child = spawn(target.command, target.args, spawnOpts)
    const max = opts.maxBuffer ?? 8 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolveRun({ code, stdout, stderr, ok: code === 0 })
    }

    function onAbort() {
      child.kill('SIGTERM')
      stderr += '\n[cockpit] cancelled'
      finish(130)
    }

    // SIGTERM first: git removes its lock files (.git/index.lock) on SIGTERM
    // but cannot on SIGKILL, and a lock left behind stops every later git call
    // in that repository with exit 128. The result waits for the process to
    // go, so the per-repository queue never starts the next git while this one
    // still holds the lock; SIGKILL only if it ignores the first signal.
    let timedOut = false
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      stderr += '\n[cockpit] timed out after ' + (opts.timeoutMs ?? 60000) + 'ms'
      child.kill('SIGTERM')
      killer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(124)
      }, 3000)
    }, opts.timeoutMs ?? 60_000)

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += String(err)
      finish(127)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      finish(timedOut ? 124 : (code ?? 0))
    })
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input)
      child.stdin?.end()
    } else {
      child.stdin?.end()
    }
  })
}

export async function which(bin: string): Promise<string | null> {
  if (IS_WIN) return resolveWin(bin)
  const r = await run('/usr/bin/which', [bin], { timeoutMs: 4000 })
  const line = r.stdout.trim().split('\n')[0]
  return r.ok && line ? line : null
}

/**
 * §16 — "File d'exécution par dépôt pour les commandes Git."
 * Two git commands in the same repo never overlap.
 */
const queues = new Map<string, Promise<unknown>>()

export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    key,
    next.catch(() => undefined),
  )
  return next
}
