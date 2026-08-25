import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { MANIFEST_TEMPLATE } from '@cockpit/shared'
import type { Workspace } from '@cockpit/shared'
import { CoreClient } from './client.js'

/**
 * §15 — "le noyau CLI doit être utilisable sans l'application." A colleague
 * clones the repo, runs one command, gets a working environment, without ever
 * installing the desktop app.
 */

const PORT = Number(process.env.COCKPIT_PORT ?? 7717)
const URL = 'ws://127.0.0.1:' + PORT

const C = {
  dim: (s: string) => '\x1b[2m' + s + '\x1b[0m',
  bold: (s: string) => '\x1b[1m' + s + '\x1b[0m',
  green: (s: string) => '\x1b[32m' + s + '\x1b[0m',
  yellow: (s: string) => '\x1b[33m' + s + '\x1b[0m',
  red: (s: string) => '\x1b[31m' + s + '\x1b[0m',
  blue: (s: string) => '\x1b[34m' + s + '\x1b[0m',
  mag: (s: string) => '\x1b[35m' + s + '\x1b[0m',
}

function out(s = ''): void {
  process.stdout.write(s + '\n')
}

async function connect(): Promise<CoreClient> {
  const client = new CoreClient(URL)
  try {
    await client.connect()
  } catch (e) {
    out(C.red('cockpit core is not running.'))
    out('Start it with:  ' + C.bold('cockpit daemon') + '   (or: pnpm daemon)')
    out(C.dim(String(e instanceof Error ? e.message : e)))
    process.exit(1)
  }
  return client
}

/** §12 — the same compact status line the UI shows, in one row per workspace. */
function workspaceLine(w: Workspace): string {
  const parts: string[] = []
  const kind =
    w.kind === 'main' ? C.blue('main') : w.kind === 'worktree' ? C.mag('tree') : C.dim(w.kind.slice(0, 4))
  parts.push(kind)
  parts.push(C.bold(w.name.padEnd(24).slice(0, 24)))

  if (w.git) {
    const g = w.git
    const ab =
      (g.ahead ? C.green('↑' + g.ahead) : C.dim('↑0')) + ' ' + (g.behind ? C.yellow('↓' + g.behind) : C.dim('↓0'))
    const dirty = g.staged + g.unstaged + g.untracked
    parts.push(ab)
    parts.push(dirty ? C.yellow('●' + dirty) : C.dim('  clean'))
    if (g.conflicted) parts.push(C.red('!' + g.conflicted))
    if (g.headState !== 'attached') parts.push(C.red(g.headState))
  } else {
    parts.push(C.dim('no repo'))
  }

  // §3.9 — absent capabilities print nothing at all.
  if (w.runtime) {
    const dot =
      w.runtime.status === 'up' ? C.green('●') : w.runtime.status === 'starting' ? C.yellow('◐') : C.dim('○')
    parts.push(dot + ' ' + C.dim(w.runtime.impl))
  }
  if (w.agentSessions.length) parts.push(C.mag('🤖' + w.agentSessions.length))
  if (w.lease) parts.push(C.yellow('🔒'))
  if (w.hasMemory) parts.push(C.dim('mem'))

  return parts.join(' ')
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async daemon() {
    // Runs the core in the foreground; launchd/systemd wraps this in packaging.
    const here = dirname(fileURLToPath(import.meta.url))
    const entry = resolve(here, '..', '..', 'core', 'src', 'index.ts')
    const child = spawn('npx', ['tsx', entry], { stdio: 'inherit', env: process.env })
    child.on('exit', (code) => process.exit(code ?? 0))
    await new Promise(() => undefined)
  },

  async status() {
    const c = await connect()
    const s = await c.call('core.status', undefined)
    out(C.bold('cockpit core') + '  ' + C.dim('v' + s.version + ' · protocol v' + s.protocol.major))
    out('  pid           ' + s.pid)
    out('  uptime        ' + Math.round((Date.now() - s.startedAt) / 1000) + 's')
    out('  projects      ' + s.projects)
    out('  workspaces    ' + s.workspaces)
    out('  journal       ' + s.journalEvents + ' events')
    out('  leases        ' + s.activeLeases)
    out('  processes     ' + s.activeProcesses)
    c.close()
  },

  async ls(args) {
    const c = await connect()
    const projects = await c.call('project.list', undefined)
    const workspaces = await c.call('workspace.list', {})
    if (!projects.length) {
      out(C.dim('No project registered. Add one with:  cockpit add <path>'))
      c.close()
      return
    }
    for (const p of projects) {
      if (args[0] && !p.name.includes(args[0])) continue
      const caps = p.capabilities.map((x) => x.id).join(' ')
      out('')
      out(C.bold(p.name) + '  ' + C.dim(p.root))
      out(C.dim('  ' + p.defaultCeremony + (caps ? ' · ' + caps : '') + (p.manifestPath ? '' : ' · no manifest')))
      for (const w of workspaces.filter((w) => w.projectId === p.id)) {
        out('  ' + workspaceLine(w))
      }
    }
    out('')
    c.close()
  },

  async add(args) {
    const root = resolve(args[0] ?? '.')
    const c = await connect()
    const p = await c.call('project.add', { root })
    out(C.green('added ') + C.bold(p.name) + ' ' + C.dim(p.root))
    out(C.dim('  capabilities: ' + (p.capabilities.map((x) => x.id + ':' + x.impl).join(', ') || 'none detected')))
    c.close()
  },

  async forget(args) {
    const c = await connect()
    const projects = await c.call('project.list', undefined)
    const target = projects.find((p) => p.name === args[0] || p.root === resolve(args[0] ?? ''))
    if (!target) {
      out(C.red('no such project: ' + args[0]))
      process.exit(1)
    }
    await c.call('project.forget', { projectId: target.id })
    out(C.green('forgotten ') + target.name)
    c.close()
  },

  async reconcile() {
    const c = await connect()
    const r = await c.call('core.reconcile', {})
    out(C.green('reconciled ') + r.changed + ' workspace(s)')
    c.close()
  },

  async diff(args) {
    const c = await connect()
    const w = await pickWorkspace(c, args[0])
    const files = await c.call('diff.files', { workspaceId: w.id })
    if (!files.length) {
      out(C.dim('no changes'))
      c.close()
      return
    }
    // §12 — the author split is the point of this view.
    const mark = (a: string) => (a === 'agent' ? C.mag('◆') : a === 'human' ? C.green('●') : a === 'mixed' ? C.yellow('◑') : C.dim('·'))
    for (const f of files) {
      out(
        '  ' + mark(f.attribution) + ' ' + f.status + ' ' + f.path.padEnd(50).slice(0, 50) +
          C.green('+' + f.additions) + ' ' + C.red('-' + f.deletions),
      )
    }
    const byAuthor = files.reduce<Record<string, number>>((acc, f) => {
      acc[f.attribution] = (acc[f.attribution] ?? 0) + 1
      return acc
    }, {})
    out('')
    out(C.dim('  ' + Object.entries(byAuthor).map(([k, v]) => k + ' ' + v).join(' · ')))
    c.close()
  },

  async search(args) {
    const query = args.join(' ')
    if (!query) {
      out('usage: cockpit search <query>')
      process.exit(1)
    }
    const c = await connect()
    const workspaces = await c.call('workspace.list', {})
    // §12 — searching every repo at once is the thing no IDE gives easily.
    const ids = workspaces.filter((w) => w.kind !== 'group').map((w) => w.id)
    const r = await c.call('search.text', { workspaceIds: ids, query })
    const nameOf = new Map(workspaces.map((w) => [w.id, w.name]))
    for (const h of r.hits) {
      out(
        C.dim(nameOf.get(h.workspaceId) ?? '?') + ' ' + C.blue(h.path) + ':' + h.line + '  ' + h.text.trim().slice(0, 120),
      )
    }
    out('')
    out(C.dim('  ' + r.hits.length + ' hit(s) via ' + r.engine + (r.truncated ? ' (truncated)' : '')))
    c.close()
  },

  async plan(args) {
    const c = await connect()
    const op = args[0]
    if (!op) {
      out('usage: cockpit plan <rebase|merge|branch|worktree|push|sync> [workspace] [--name X]')
      process.exit(1)
    }
    const w = await pickWorkspace(c, args[1])
    const nameIdx = args.indexOf('--name')
    const extra: Record<string, string> = nameIdx >= 0 ? { name: args[nameIdx + 1] ?? '' } : {}
    const p = await c.call('git.plan', { workspaceId: w.id, operation: op as 'rebase', args: extra })
    printPlan(p)
    out(C.dim('  apply with:  cockpit apply ' + p.planId))
    c.close()
  },

  async apply(args) {
    const c = await connect()
    const planId = args[0]
    if (!planId) {
      out('usage: cockpit apply <planId>')
      process.exit(1)
    }
    const r = await c.call('git.apply', { planId })
    out(r.output)
    out(r.ok ? C.green('applied') : C.red('failed'))
    if (r.restorePoint) out(C.dim('  restore point ' + r.restorePoint.slice(0, 8) + ' · undo with: cockpit undo'))
    c.close()
    process.exit(r.ok ? 0 : 1)
  },

  async undo(args) {
    const c = await connect()
    const w = await pickWorkspace(c, args[0])
    const r = await c.call('git.undo', { workspaceId: w.id })
    out(r.ok ? C.green(r.detail) : C.red(r.detail))
    c.close()
  },

  async up(args) {
    const c = await connect()
    const w = await pickWorkspace(c, args[0])
    const r = await c.call('runtime.up', { workspaceId: w.id })
    out(r.ok ? C.green(r.detail) : C.red(r.detail))
    c.close()
  },

  async down(args) {
    const c = await connect()
    const w = await pickWorkspace(c, args[0])
    const r = await c.call('runtime.down', { workspaceId: w.id })
    out(r.ok ? C.green(r.detail) : C.red(r.detail))
    c.close()
  },

  async agent(args) {
    const c = await connect()
    const sub = args[0]
    if (sub === 'list') {
      const sessions = await c.call('agent.list', undefined)
      for (const s of sessions) {
        out(
          '  ' + C.mag(s.engine.padEnd(8)) + s.status.padEnd(10) +
            C.dim(s.turns + ' turns · $' + s.costUsd.toFixed(2)) + '  ' + C.dim(s.paths.join(', ')),
        )
      }
      c.close()
      return
    }
    if (sub === 'engines') {
      for (const e of await c.call('agent.engines', undefined)) {
        out('  ' + (e.available ? C.green('●') : C.dim('○')) + ' ' + e.id.padEnd(10) + C.dim(e.bin))
      }
      c.close()
      return
    }
    // `cockpit agent <engine> <prompt...>` — C0, two keystrokes' worth (§12).
    const engine = sub ?? 'claude'
    const prompt = args.slice(1).join(' ')
    if (!prompt) {
      out('usage: cockpit agent <engine> <prompt>   |   cockpit agent list | engines')
      process.exit(1)
    }
    const w = await pickWorkspace(c, undefined)
    const r = await c.call('agent.start', { engine, workspaceIds: [w.id], prompt })
    if ('denied' in r) {
      out(C.red('denied: ') + r.reason)
      c.close()
      process.exit(1)
    }
    out(C.green('started ') + r.sessionId + C.dim(' on ' + w.path))
    c.close()
  },

  async memory(args) {
    const c = await connect()
    const sub = args[0] ?? 'show'

    if (sub === 'promote') {
      // memory promote <section> <text...>  — the section is not a workspace.
      const section = args[1]
      const text = args.slice(2).join(' ')
      if (!section || !text) {
        out('usage: cockpit memory promote <section> <text…>')
        out(C.dim('  sections: Objectif · Décisions · Contraintes · Écarté · État'))
        c.close()
        process.exit(1)
      }
      const target = await pickWorkspace(c, undefined)
      await c.call('memory.promote', { workspaceId: target.id, section, text })
      out(C.green('promoted into ') + section + C.dim(' · ' + target.name))
      c.close()
      return
    }

    // memory show [workspace]
    const w = await pickWorkspace(c, args[1])
    const doc = await c.call('memory.read', { workspaceId: w.id })
    if (!doc) {
      out(C.dim('no memory for ' + w.name + '. Create one with:'))
      out(C.dim('  cockpit memory promote Objectif "what this work is for"'))
    } else {
      out(doc.content)
    }
    c.close()
  },

  async journal(args) {
    const c = await connect()
    const limit = Number(args[0] ?? 40)
    const events = await c.call('journal.tail', { limit })
    for (const e of events) {
      const t = new Date(e.ts).toLocaleTimeString()
      const who = e.actor.kind === 'agent' ? C.mag(e.actor.engine) : e.actor.kind === 'system' ? C.dim('system') : C.green('human')
      out(C.dim(t) + ' ' + who.padEnd(18) + C.bold(e.type.padEnd(24)) + C.dim(JSON.stringify(e.payload).slice(0, 90)))
    }
    c.close()
  },

  async ports() {
    const c = await connect()
    const map = await c.call('ports.map', undefined)
    if (!map.length) out(C.dim('no ports allocated yet'))
    // §11 — allocation is global; that is exactly why this listing is flat.
    for (const p of map) out('  ' + C.bold(String(p.port)) + '  ' + p.name.padEnd(12) + C.dim(p.owner))
    c.close()
  },

  async leases() {
    const c = await connect()
    const list = await c.call('lease.list', undefined)
    if (!list.length) out(C.dim('no active lease'))
    for (const l of list) {
      out('  ' + C.yellow(l.id.slice(0, 12)) + ' ' + l.holder.padEnd(16) + C.dim(l.paths.join(', ')))
    }
    c.close()
  },

  async init(args) {
    const root = resolve(args[0] ?? '.')
    const target = join(root, 'cockpit.yaml')
    if (existsSync(target)) {
      out(C.yellow('cockpit.yaml already exists'))
      process.exit(1)
    }
    writeFileSync(target, MANIFEST_TEMPLATE, 'utf8')
    out(C.green('wrote ') + target)
    out(C.dim('  edit it, then:  cockpit add ' + root))
  },

  async help() {
    out('')
    out(C.bold('cockpit') + C.dim(' — plan de contrôle du cycle de développement'))
    out('')
    out(C.bold('  state'))
    out('    status                      core health and counters')
    out('    ls [project]                projects and workspaces')
    out('    reconcile                   re-probe everything now')
    out('    journal [n]                 last n events')
    out('    ports                       global port allocation')
    out('    leases                      active path leases')
    out('')
    out(C.bold('  projects'))
    out('    init [path]                 write a starter cockpit.yaml')
    out('    add <path>                  register a project')
    out('    forget <name>               unregister a project')
    out('')
    out(C.bold('  work'))
    out('    diff [workspace]            changed files, split human / agent')
    out('    search <query>              full-text across every repo at once')
    out('    plan <op> [ws] [--name X]   preview a git operation')
    out('    apply <planId>              run a previewed plan')
    out('    undo [workspace]            roll back to the last restore point')
    out('    up | down [workspace]       start / stop the runtime')
    out('')
    out(C.bold('  agents & memory'))
    out('    agent engines               which engines are installed')
    out('    agent list                  running sessions')
    out('    agent <engine> <prompt>     start a session here (C0)')
    out('    memory show [workspace]     read the feature memory')
    out('    memory promote <s> <text>   push a decision into the memory')
    out('')
    out(C.bold('  service'))
    out('    daemon                      run the core in the foreground')
    out('')
  },
}

function printPlan(p: { operation: string; steps: { title: string; command: string; destructive: boolean }[]; warnings: string[]; capturesRestorePoint: boolean }): void {
  out('')
  out(C.bold('plan · ' + p.operation))
  for (const [i, s] of p.steps.entries()) {
    const n = C.dim(String(i + 1) + '.')
    out('  ' + n + ' ' + (s.destructive ? C.red(s.title) : s.title))
    out('     ' + C.dim(s.command))
  }
  for (const w of p.warnings) out('  ' + C.yellow('! ' + w))
  if (p.capturesRestorePoint) out('  ' + C.dim('a restore point will be captured first'))
  out('')
}

/** Defaults to the workspace containing the current directory — the cockpit
 *  reads the organisation, it does not ask the user to restate it (§3.5). */
async function pickWorkspace(c: CoreClient, hint?: string): Promise<Workspace> {
  const workspaces = await c.call('workspace.list', {})
  if (hint) {
    const found = workspaces.find((w) => w.name === hint || w.id === hint || w.path.endsWith('/' + hint))
    if (found) return found
    out(C.red('no workspace matching "' + hint + '"'))
    process.exit(1)
  }
  const cwd = resolve(process.cwd())
  const here = workspaces
    .filter((w) => cwd === w.path || cwd.startsWith(w.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (here) return here
  const first = workspaces[0]
  if (!first) {
    out(C.red('no workspace registered. Try: cockpit add .'))
    process.exit(1)
  }
  return first
}

async function main(): Promise<void> {
  const [, , cmd = 'help', ...args] = process.argv
  const fn = commands[cmd] ?? commands.help!
  try {
    await fn(args)
  } catch (e) {
    out(C.red(e instanceof Error ? e.message : String(e)))
    process.exit(1)
  }
}

void main()
