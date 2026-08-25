import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

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
}

/**
 * §16 — "Aucun environnement de process journalisé": we pass the parent env
 * through but never write it to the journal.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    const child = spawn(cmd, args, spawnOpts)
    const max = opts.maxBuffer ?? 8 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr, ok: code === 0 })
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      stderr += '\n[cockpit] timed out after ' + (opts.timeoutMs ?? 60000) + 'ms'
      finish(124)
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
    child.on('close', (code) => finish(code ?? 0))

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input)
      child.stdin?.end()
    } else {
      child.stdin?.end()
    }
  })
}

export async function which(bin: string): Promise<string | null> {
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
