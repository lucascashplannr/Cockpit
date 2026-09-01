import { createServer } from 'node:net'
import { loadConfig, updateConfig } from './config.js'

/**
 * §11, "Décision immédiate" — allocation is GLOBAL across all projects, not
 * per project. Expo's fixed 8081 is exactly the collision this prevents, and
 * making it global later would be a migration.
 *
 * Deterministic: the same (project, workspace, service) triple always gets the
 * same port, so a restart does not reshuffle every URL the user has bookmarked.
 */

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function portKey(projectId: string, workspaceId: string, service: string): string {
  return projectId + '/' + workspaceId + '/' + service
}

function freeOn(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer()
    srv.once('error', () => res(false))
    srv.once('listening', () => srv.close(() => res(true)))
    srv.listen(port, host)
  })
}

/**
 * Free on *both* loopback families, not just IPv4.
 *
 * Checking only `127.0.0.1` made the allocator blind to the servers most
 * likely to be running: Vite binds `[::1]` and nothing else, so a port it was
 * already serving on looked free and got handed to a second workspace. With
 * `--strictPort` that now fails loudly instead of silently stealing, but the
 * allocation should not have happened at all.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([freeOn(port, '127.0.0.1'), freeOn(port, '::1')])
  return v4 && v6
}

/**
 * Returns the already-assigned port when there is one, otherwise probes
 * forward from the deterministic slot until it finds a free, unclaimed port.
 */
export async function allocate(key: string): Promise<number> {
  const cfg = loadConfig()
  const existing = cfg.portAssignments[key]
  if (existing) return existing

  const [lo, hi] = cfg.portRange
  const span = hi - lo + 1
  const taken = new Set<number>([...Object.values(cfg.portAssignments), ...cfg.portBlocklist])

  const start = hash(key) % span
  for (let i = 0; i < span; i++) {
    const port = lo + ((start + i) % span)
    if (taken.has(port)) continue
    if (!(await isPortFree(port))) continue
    updateConfig((c) => {
      c.portAssignments[key] = port
    })
    return port
  }
  throw new Error('no free port in range ' + lo + '-' + hi)
}

export function release(key: string): void {
  updateConfig((c) => {
    delete c.portAssignments[key]
  })
}

export function releaseForWorkspace(projectId: string, workspaceId: string): void {
  const prefix = projectId + '/' + workspaceId + '/'
  updateConfig((c) => {
    for (const k of Object.keys(c.portAssignments)) {
      if (k.startsWith(prefix)) delete c.portAssignments[k]
    }
  })
}

export function portMap(): { port: number; owner: string; name: string }[] {
  const cfg = loadConfig()
  return Object.entries(cfg.portAssignments)
    .map(([key, port]) => {
      const parts = key.split('/')
      return { port, owner: parts.slice(0, 2).join('/'), name: parts[2] ?? '?' }
    })
    .sort((a, b) => a.port - b.port)
}
