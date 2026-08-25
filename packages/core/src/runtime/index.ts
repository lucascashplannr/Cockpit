import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RuntimeState, Workspace } from '@cockpit/shared'
import { run } from '../exec.js'
import { allocate, portKey } from '../ports.js'
import { append } from '../journal.js'
import * as sup from '../supervisor.js'

/**
 * §8 — "Il unifie les questions qu'il pose, pas les réponses."
 * Every runtime answers the same seven verbs; none of them share a schema.
 */
export interface Runtime {
  id: string
  /** §8 — can this workspace run somewhere other than this machine? */
  portable: boolean
  /** §8 — can several workspaces of this runtime run at once? */
  exclusive: boolean
  provision(ws: Workspace): Promise<{ ok: boolean; detail: string }>
  up(ws: Workspace): Promise<{ ok: boolean; detail: string }>
  down(ws: Workspace): Promise<{ ok: boolean; detail: string }>
  health(ws: Workspace): Promise<{ status: RuntimeState['status']; detail: string }>
  preview(ws: Workspace): Promise<NonNullable<RuntimeState['preview']>>
  ports(ws: Workspace): Promise<{ name: string; port: number }[]>
}

function runtimeDetail(ws: Workspace): Record<string, unknown> {
  return (ws.capabilities.find((c) => c.id === 'runtime')?.detail ?? {}) as Record<string, unknown>
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
    clearTimeout(t)
    return res.status < 500
  } catch {
    return false
  }
}

/** A plain `npm run dev` style server. The most common case by far. */
const nodeRuntime: Runtime = {
  id: 'node',
  portable: true,
  exclusive: false,
  async provision(ws) {
    if (existsSync(join(ws.path, 'node_modules'))) return { ok: true, detail: 'dependencies present' }
    const pm = existsSync(join(ws.path, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(ws.path, 'yarn.lock'))
        ? 'yarn'
        : 'npm'
    const r = await run(pm, ['install'], { cwd: ws.path, timeoutMs: 600_000 })
    return { ok: r.ok, detail: r.ok ? pm + ' install done' : r.stderr.slice(-800) }
  },
  async up(ws) {
    const detail = runtimeDetail(ws)
    const script = String(detail.script ?? 'dev')
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    const pm = existsSync(join(ws.path, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(ws.path, 'yarn.lock'))
        ? 'yarn'
        : 'npm'
    sup.start({
      workspaceId: ws.id,
      label: pm + ' run ' + script,
      cwd: ws.path,
      command: pm,
      args: ['run', script],
      env: { PORT: String(port) },
    })
    return { ok: true, detail: 'started on port ' + port }
  },
  async down(ws) {
    const n = sup.stopWorkspace(ws.id)
    return { ok: true, detail: 'stopped ' + n + ' process(es)' }
  },
  async health(ws) {
    const procs = sup.listForWorkspace(ws.id)
    if (!procs.length) return { status: 'down', detail: 'no process' }
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    const ok = await httpOk('http://127.0.0.1:' + port)
    return { status: ok ? 'up' : 'starting', detail: 'port ' + port }
  },
  async preview(ws) {
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    return { kind: 'url', value: 'http://127.0.0.1:' + port }
  },
  async ports(ws) {
    return [{ name: 'web', port: await allocate(portKey(ws.projectId, ws.id, 'web')) }]
  },
}

/**
 * §11 — Expo. The bundler defaults to 8081, which collides across projects;
 * the global allocator is what makes several bundlers coexist.
 */
const expoRuntime: Runtime = {
  ...nodeRuntime,
  id: 'expo',
  exclusive: false,
  async up(ws) {
    const port = await allocate(portKey(ws.projectId, ws.id, 'bundler'))
    sup.start({
      workspaceId: ws.id,
      label: 'expo start',
      cwd: ws.path,
      command: 'npx',
      args: ['expo', 'start', '--port', String(port)],
    })
    return { ok: true, detail: 'bundler on ' + port }
  },
  async preview(ws) {
    const port = await allocate(portKey(ws.projectId, ws.id, 'bundler'))
    // §11 — preview returns the bundler URL and a QR payload; the UI renders
    // whichever it can. The verb already generalises, no new concept needed.
    return { kind: 'qr', value: 'exp://127.0.0.1:' + port }
  },
  async health(ws) {
    const procs = sup.listForWorkspace(ws.id)
    if (!procs.length) return { status: 'down', detail: 'no bundler' }
    const port = await allocate(portKey(ws.projectId, ws.id, 'bundler'))
    const ok = await httpOk('http://127.0.0.1:' + port + '/status')
    return { status: ok ? 'up' : 'starting', detail: 'bundler ' + port }
  },
  async ports(ws) {
    return [{ name: 'bundler', port: await allocate(portKey(ws.projectId, ws.id, 'bundler')) }]
  },
}

const composeRuntime: Runtime = {
  id: 'compose',
  portable: true,
  exclusive: false,
  async provision(ws) {
    const r = await run('docker', ['compose', 'build'], { cwd: ws.path, timeoutMs: 900_000 })
    return { ok: r.ok, detail: r.ok ? 'built' : r.stderr.slice(-800) }
  },
  async up(ws) {
    const r = await run('docker', ['compose', 'up', '-d'], { cwd: ws.path, timeoutMs: 300_000 })
    return { ok: r.ok, detail: r.ok ? 'compose up' : r.stderr.slice(-800) }
  },
  async down(ws) {
    const r = await run('docker', ['compose', 'down'], { cwd: ws.path, timeoutMs: 120_000 })
    return { ok: r.ok, detail: r.ok ? 'compose down' : r.stderr.slice(-800) }
  },
  async health(ws) {
    const r = await run('docker', ['compose', 'ps', '--format', 'json'], { cwd: ws.path, timeoutMs: 20_000 })
    if (!r.ok) return { status: 'unknown', detail: 'docker unavailable' }
    const lines = r.stdout.split('\n').filter(Boolean)
    if (!lines.length) return { status: 'down', detail: 'no containers' }
    const running = lines.filter((l) => l.includes('"State":"running"')).length
    return {
      status: running === lines.length ? 'up' : running ? 'unhealthy' : 'down',
      detail: running + '/' + lines.length + ' running',
    }
  },
  async preview(ws) {
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    return { kind: 'url', value: 'http://127.0.0.1:' + port }
  },
  async ports(ws) {
    return [{ name: 'web', port: await allocate(portKey(ws.projectId, ws.id, 'web')) }]
  },
}

/**
 * Laravel Herd. Not portable: it is a machine-local service, and §8 says such
 * a runtime must say so explicitly rather than silently failing elsewhere.
 */
const herdRuntime: Runtime = {
  id: 'herd',
  portable: false,
  exclusive: false,
  async provision(ws) {
    if (existsSync(join(ws.path, 'vendor'))) return { ok: true, detail: 'vendor present' }
    const r = await run('composer', ['install'], { cwd: ws.path, timeoutMs: 600_000 })
    return { ok: r.ok, detail: r.ok ? 'composer install done' : r.stderr.slice(-800) }
  },
  async up(ws) {
    // Herd serves linked folders permanently; "up" means link + ensure served.
    const r = await run('herd', ['link', basename(ws.path)], { cwd: ws.path, timeoutMs: 30_000 })
    return { ok: r.ok, detail: r.ok ? 'linked' : 'herd CLI unavailable' }
  },
  async down(ws) {
    const r = await run('herd', ['unlink', basename(ws.path)], { cwd: ws.path, timeoutMs: 30_000 })
    return { ok: r.ok, detail: r.ok ? 'unlinked' : 'herd CLI unavailable' }
  },
  async health(ws) {
    const url = herdUrl(ws)
    const ok = await httpOk(url)
    return { status: ok ? 'up' : 'down', detail: url }
  },
  async preview(ws) {
    return { kind: 'url', value: herdUrl(ws) }
  },
  async ports() {
    return []
  },
}

function herdUrl(ws: Workspace): string {
  const detail = runtimeDetail(ws)
  const tld = String(detail.tld ?? 'test')
  return 'http://' + basename(ws.path) + '.' + tld
}

const devcontainerRuntime: Runtime = {
  ...composeRuntime,
  id: 'devcontainer',
  async up(ws) {
    const r = await run('devcontainer', ['up', '--workspace-folder', ws.path], { timeoutMs: 900_000 })
    return { ok: r.ok, detail: r.ok ? 'devcontainer up' : r.stderr.slice(-800) }
  },
}

/** §3.9 — no runtime means no server button at all, not a disabled one. */
const REGISTRY: Record<string, Runtime> = {
  node: nodeRuntime,
  expo: expoRuntime,
  compose: composeRuntime,
  herd: herdRuntime,
  devcontainer: devcontainerRuntime,
}

export function runtimeFor(ws: Workspace): Runtime | null {
  const cap = ws.capabilities.find((c) => c.id === 'runtime')
  if (!cap) return null
  return REGISTRY[cap.impl] ?? null
}

export async function runtimeStateFor(ws: Workspace): Promise<RuntimeState | null> {
  const rt = runtimeFor(ws)
  if (!rt) return null
  const processes = sup.listForWorkspace(ws.id)
  const [health, ports] = await Promise.all([
    processes.length || rt.id === 'herd' || rt.id === 'compose'
      ? rt.health(ws)
      : Promise.resolve({ status: 'down' as const, detail: 'not started' }),
    rt.ports(ws).catch(() => []),
  ])
  const preview = health.status === 'up' ? await rt.preview(ws).catch(() => null) : null
  return {
    impl: rt.id,
    status: health.status,
    preview,
    ports: ports.map((p) => ({ name: p.name, port: p.port, scope: 'global' as const })),
    portable: rt.portable,
    exclusive: rt.exclusive,
    processes,
  }
}

export async function up(ws: Workspace) {
  const rt = runtimeFor(ws)
  if (!rt) return { ok: false, detail: 'no runtime for this workspace' }
  append({ type: 'runtime.provision', workspaceId: ws.id, payload: { impl: rt.id } })
  const prov = await rt.provision(ws)
  if (!prov.ok) return prov
  const res = await rt.up(ws)
  append({
    type: 'runtime.up',
    level: res.ok ? 'info' : 'error',
    workspaceId: ws.id,
    payload: { impl: rt.id, detail: res.detail },
  })
  return res
}

export async function down(ws: Workspace) {
  const rt = runtimeFor(ws)
  if (!rt) return { ok: false, detail: 'no runtime for this workspace' }
  const res = await rt.down(ws)
  sup.stopWorkspace(ws.id)
  append({ type: 'runtime.down', workspaceId: ws.id, payload: { impl: rt.id, detail: res.detail } })
  return res
}

export async function health(ws: Workspace) {
  const rt = runtimeFor(ws)
  if (!rt) return { status: 'unknown', detail: 'no runtime' }
  const r = await rt.health(ws)
  append({ type: 'runtime.health', level: 'debug', workspaceId: ws.id, payload: r })
  return r
}

export async function preview(ws: Workspace) {
  const rt = runtimeFor(ws)
  if (!rt) return { kind: 'none' as const }
  return rt.preview(ws)
}

/** Reads a compose file only to surface service names in the UI. */
export function composeServices(ws: Workspace): string[] {
  const detail = runtimeDetail(ws)
  const file = String(detail.file ?? 'compose.yaml')
  const p = join(ws.path, file)
  if (!existsSync(p)) return []
  try {
    const text = readFileSync(p, 'utf8')
    const out: string[] = []
    let inServices = false
    for (const line of text.split('\n')) {
      if (/^services:\s*$/.test(line)) {
        inServices = true
        continue
      }
      if (inServices) {
        if (/^\S/.test(line)) break
        const m = /^ {2}(\w[\w-]*):/.exec(line)
        if (m?.[1]) out.push(m[1])
      }
    }
    return out
  } catch {
    return []
  }
}
