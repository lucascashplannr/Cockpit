import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { scopedName as scopedNameFor } from '@cockpit/shared'
import type { RuntimeState, RuntimeUpResult, Workspace } from '@cockpit/shared'
import type { Framework } from '../detect.js'
import { run } from '../exec.js'
import { allocate, portKey } from '../ports.js'
import { append } from '../journal.js'
import * as sup from '../supervisor.js'
import * as topicStore from '../topics/store.js'

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
  /**
   * `procId` is how `up` below watches what it started: a process that dies
   * during the wait is the answer, and the fastest one available. A runtime
   * with nothing to supervise — Herd links a folder, Compose detaches — simply
   * omits it and is judged on its health check alone.
   */
  up(ws: Workspace): Promise<{ ok: boolean; detail: string; procId?: string }>
  down(ws: Workspace): Promise<{ ok: boolean; detail: string }>
  health(ws: Workspace): Promise<{ status: RuntimeState['status']; detail: string }>
  preview(ws: Workspace): Promise<NonNullable<RuntimeState['preview']>>
  ports(ws: Workspace): Promise<{ name: string; port: number }[]>
}

function runtimeDetail(ws: Workspace): Record<string, unknown> {
  return (ws.capabilities.find((c) => c.id === 'runtime')?.detail ?? {}) as Record<string, unknown>
}

/**
 * A name unique across topics, for runtimes that key on the folder name.
 *
 * This is the collision that breaks running two topics at once, and it is
 * silent: `worktrees/2fa/api` and `worktrees/search/api` are both `api`, so
 * Docker Compose adopts the other topic's containers and Herd serves one
 * topic's code at the other's hostname. The disambiguator is the topic.
 */
function scopedName(ws: Workspace): string {
  const base = basename(ws.path)
  if (!ws.topicId) return base
  const slug = topicStore.get(ws.topicId)?.slug ?? ws.git?.branch ?? null
  // The same function the seed uses to write this hostname into `.env`. Two
  // implementations of it would be one bug: Herd serving `api-2fa.test` while
  // the app inside it believes it is `api-two-fa.test`.
  return scopedNameFor(base, slug)
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

/**
 * The two loopback addresses, because a dev server picks one and they are not
 * interchangeable.
 *
 * Vite binds `[::1]` and nothing else, so polling `127.0.0.1` — which is what
 * every health check here used to do — is refused by a server that is up and
 * serving perfectly. That reported `starting` forever, indistinguishable from
 * a server that never came up, and it is the second half of why Start could
 * not be trusted: fixing the port alone would have moved the failure rather
 * than removed it.
 */
const LOOPBACKS = ['127.0.0.1', '[::1]'] as const

/** True as soon as either family answers. */
async function listening(port: number, path = ''): Promise<boolean> {
  const tries = await Promise.all(LOOPBACKS.map((h) => httpOk('http://' + h + ':' + port + path)))
  return tries.some(Boolean)
}

/**
 * The URL to hand a person, as opposed to the one to poll.
 *
 * `localhost` rather than a literal address on purpose: it resolves to
 * whichever family the server actually chose, so the link works without the
 * window having to know which one that was.
 */
const localUrl = (port: number) => 'http://localhost:' + port

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * §11 — how each dev server is told the port the allocator picked for it.
 *
 * `PORT` in the environment is a convention, not a rule, and the most common
 * dev server on this machine ignores it: Vite reads `--port` and otherwise
 * binds 5173 whatever the environment says. That does not fail — it *runs*, on
 * a number nothing in the window knows about, so health polls the allocated
 * port forever, reports `starting`, and Preview opens a URL with nothing
 * behind it. Passing the port a way the server actually listens to is the
 * difference between the allocator being true and being decorative.
 *
 * `--strictPort` is Vite's own, and it is deliberate: the allocator already
 * proved this port free, so a Vite that moved to the next one has hit
 * something Cockpit cannot see. Failing loudly beats drifting silently.
 */
interface PortStyle {
  flag: string | null
  extra: string[]
  env: string[]
}

/** Nothing recognised: the convention is all there is, so use it and say so. */
const PORT_BY_ENV: PortStyle = { flag: null, extra: [], env: ['PORT'] }

const PORT_STYLES: Record<string, PortStyle> = {
  vite: { flag: '--port', extra: ['--strictPort'], env: [] },
  quasar: { flag: '--port', extra: [], env: [] },
  next: { flag: '--port', extra: [], env: ['PORT'] },
  nuxt: { flag: '--port', extra: [], env: ['PORT', 'NUXT_PORT'] },
  astro: { flag: '--port', extra: [], env: [] },
  angular: { flag: '--port', extra: [], env: [] },
}

/** A plain `npm run dev` style server. The most common case by far. */
const nodeRuntime: Runtime = {
  id: 'node',
  portable: true,
  exclusive: false,
  async provision(ws) {
    if (existsSync(join(ws.path, 'node_modules'))) return { ok: true, detail: 'dependencies present' }
    const pm = packageManager(ws.path)
    const r = await run(pm, ['install'], { cwd: ws.path, timeoutMs: 600_000 })
    return { ok: r.ok, detail: r.ok ? pm + ' install done' : r.stderr.slice(-800) }
  },
  async up(ws) {
    const detail = runtimeDetail(ws)
    const script = String(detail.script ?? 'dev')
    const framework = (detail.framework as Framework) ?? null
    const style = (framework ? PORT_STYLES[framework] : null) ?? PORT_BY_ENV
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    const pm = packageManager(ws.path)

    // `--` is what makes npm forward the rest to the script rather than eat it;
    // pnpm and yarn accept it too, so one form covers all three.
    const args = ['run', script]
    if (style.flag) args.push('--', style.flag, String(port), ...style.extra)

    const env: Record<string, string> = {}
    for (const key of style.env) env[key] = String(port)

    const proc = sup.start({
      workspaceId: ws.id,
      label: pm + ' run ' + script,
      cwd: ws.path,
      command: pm,
      args,
      env,
    })
    return {
      ok: true,
      procId: proc.id,
      detail: style.flag
        ? 'port ' + port + ' via ' + style.flag
        : 'port ' + port + ' via PORT (no framework recognised — if the server picks its own port, set it in the script)',
    }
  },
  async down(ws) {
    const n = sup.stopWorkspace(ws.id)
    return { ok: true, detail: 'stopped ' + n + ' process(es)' }
  },
  async health(ws) {
    const procs = sup.listForWorkspace(ws.id)
    if (!procs.length) return { status: 'down', detail: 'no process' }
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    const ok = await listening(port)
    return { status: ok ? 'up' : 'starting', detail: 'port ' + port }
  },
  async preview(ws) {
    const port = await allocate(portKey(ws.projectId, ws.id, 'web'))
    return { kind: 'url', value: localUrl(port) }
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
    const proc = sup.start({
      workspaceId: ws.id,
      label: 'expo start',
      cwd: ws.path,
      command: 'npx',
      args: ['expo', 'start', '--port', String(port)],
    })
    return { ok: true, procId: proc.id, detail: 'bundler on ' + port }
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
    const ok = await listening(port, '/status')
    return { status: ok ? 'up' : 'starting', detail: 'bundler ' + port }
  },
  async ports(ws) {
    return [{ name: 'bundler', port: await allocate(portKey(ws.projectId, ws.id, 'bundler')) }]
  },
}

/** Every invocation carries the project namespace; forgetting one on `down`
 *  would tear down the default project instead of this topic's. */
function composeArgs(ws: Workspace, rest: string[]): string[] {
  return ['compose', '-p', 'cockpit-' + scopedName(ws), ...rest]
}

const composeRuntime: Runtime = {
  id: 'compose',
  portable: true,
  /**
   * §8 — host ports published in a compose file are literals, so two topics
   * running the same file want the same port and the second one fails deep
   * inside Docker. Cockpit refuses up front and offers to park the other (§11
   * only allocates the ports it owns; it cannot rewrite someone's compose.yaml).
   */
  exclusive: true,
  async provision(ws) {
    const r = await run('docker', composeArgs(ws, ['build']), { cwd: ws.path, timeoutMs: 900_000 })
    return { ok: r.ok, detail: r.ok ? 'built' : r.stderr.slice(-800) }
  },
  async up(ws) {
    const r = await run('docker', composeArgs(ws, ['up', '-d']), { cwd: ws.path, timeoutMs: 300_000 })
    return { ok: r.ok, detail: r.ok ? 'compose up (' + 'cockpit-' + scopedName(ws) + ')' : r.stderr.slice(-800) }
  },
  async down(ws) {
    const r = await run('docker', composeArgs(ws, ['down']), { cwd: ws.path, timeoutMs: 120_000 })
    return { ok: r.ok, detail: r.ok ? 'compose down' : r.stderr.slice(-800) }
  },
  async health(ws) {
    const r = await run('docker', composeArgs(ws, ['ps', '--format', 'json']), { cwd: ws.path, timeoutMs: 20_000 })
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
    return { kind: 'url', value: localUrl(port) }
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
    // The link name carries the topic, or two topics fight over one host.
    const r = await run('herd', ['link', scopedName(ws)], { cwd: ws.path, timeoutMs: 30_000 })
    return { ok: r.ok, detail: r.ok ? 'linked as ' + scopedName(ws) : 'herd CLI unavailable' }
  },
  async down(ws) {
    const r = await run('herd', ['unlink', scopedName(ws)], { cwd: ws.path, timeoutMs: 30_000 })
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
  return 'http://' + scopedName(ws) + '.' + tld
}

const devcontainerRuntime: Runtime = {
  ...composeRuntime,
  id: 'devcontainer',
  exclusive: true,
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

/**
 * How long to keep asking before answering `starting` rather than `up`.
 *
 * Generous on purpose: a cold webpack build or a first-run Vite dep
 * optimisation genuinely takes half a minute, and calling that a failure would
 * be a worse lie than the one this replaces.
 */
const UP_TIMEOUT_MS = 45_000
const POLL_MS = 350

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function upResult(over: Partial<RuntimeUpResult>): RuntimeUpResult {
  return { ok: false, status: 'down', detail: '', url: null, waitedMs: 0, log: '', ...over }
}

/**
 * §8 — wait for the thing that was started to actually be up, and report what
 * was observed rather than what was attempted.
 *
 * The old `up` returned `{ ok: true }` on the line after `spawn()`, so the
 * window said *started* for a process that had already died on a missing
 * dependency, and the status only corrected itself on the next probe — long
 * after the toast was gone. Three outcomes are worth telling apart, and this
 * is where they are told apart: it answered, it died (and here is what it
 * said), or it is still coming up, which is not a failure.
 */
async function settle(
  ws: Workspace,
  rt: Runtime,
  procId: string | null,
  timeoutMs: number,
): Promise<RuntimeUpResult> {
  const started = Date.now()
  let lastDetail = ''

  for (;;) {
    const waitedMs = Date.now() - started

    // A process that exited is the answer, and the fastest one there is —
    // there is no point polling a port for 45 seconds when the thing that was
    // meant to bind it is already gone.
    if (procId) {
      const st = sup.statusOf(procId)
      if (st && !st.alive) {
        return upResult({
          ok: false,
          status: 'down',
          detail: 'exited with code ' + (st.exitCode ?? '?') + ' before it answered',
          waitedMs,
          log: sup.tail(procId, 24),
        })
      }
    }

    const h = await rt.health(ws)
    lastDetail = h.detail

    if (h.status === 'up') {
      const preview = await rt.preview(ws).catch(() => null)
      return upResult({
        ok: true,
        status: 'up',
        detail: h.detail,
        url: preview?.kind === 'url' ? (preview.value ?? null) : null,
        waitedMs: Date.now() - started,
        log: procId ? sup.tail(procId, 8) : '',
      })
    }
    if (h.status === 'unhealthy') {
      return upResult({
        ok: false,
        status: 'unhealthy',
        detail: h.detail,
        waitedMs: Date.now() - started,
        log: procId ? sup.tail(procId, 24) : '',
      })
    }

    if (Date.now() - started >= timeoutMs) break
    await sleep(POLL_MS)
  }

  // Alive, but silent. Not a failure — a slow one, and saying so is the point.
  return upResult({
    ok: true,
    status: 'starting',
    detail: 'still starting after ' + Math.round(timeoutMs / 1000) + 's — ' + lastDetail,
    waitedMs: Date.now() - started,
    log: procId ? sup.tail(procId, 12) : '',
  })
}

export async function up(ws: Workspace): Promise<RuntimeUpResult> {
  const rt = runtimeFor(ws)
  if (!rt) return upResult({ status: 'unknown', detail: 'no runtime for this workspace' })

  append({ type: 'runtime.provision', workspaceId: ws.id, payload: { impl: rt.id } })
  const prov = await rt.provision(ws)
  if (!prov.ok) {
    append({
      type: 'runtime.up',
      level: 'error',
      workspaceId: ws.id,
      payload: { impl: rt.id, detail: prov.detail, phase: 'provision' },
    })
    return upResult({ detail: prov.detail, log: prov.detail })
  }

  const res = await rt.up(ws)
  if (!res.ok) {
    append({
      type: 'runtime.up',
      level: 'error',
      workspaceId: ws.id,
      payload: { impl: rt.id, detail: res.detail },
    })
    return upResult({ detail: res.detail, log: res.detail })
  }

  const settled = await settle(ws, rt, res.procId ?? null, UP_TIMEOUT_MS)
  append({
    type: 'runtime.up',
    level: settled.ok ? 'info' : 'error',
    workspaceId: ws.id,
    payload: {
      impl: rt.id,
      // What the runtime set up, then what was actually observed of it.
      detail: res.detail + ' — ' + settled.detail,
      status: settled.status,
      waitedMs: settled.waitedMs,
    },
  })
  // The launch line names the port and how it was passed; the settle line says
  // what came of it. Both matter, so neither is dropped.
  return { ...settled, detail: res.detail + ' — ' + settled.detail }
}

/** §8 — what the servers of this workspace have written, the dead included. */
export function logs(ws: Workspace) {
  return sup.logsForWorkspace(ws.id)
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
