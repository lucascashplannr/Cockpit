import { existsSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { MANIFEST_TEMPLATE, parseRemote, slugify } from '@cockpit/shared'
import type { AddRepoSource, NewProjectSource, SeedProposal, Workspace } from '@cockpit/shared'
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
  cyan: (s: string) => '\x1b[36m' + s + '\x1b[0m',
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

/** Waits for the core's port to become bound (or free). */
async function waitForPort(wantOpen: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((res) => {
      const sock = createConnection({ host: '127.0.0.1', port: PORT })
      const done = (v: boolean) => {
        sock.destroy()
        res(v)
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      setTimeout(() => done(false), 800)
    })
    if (open === wantOpen) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** `--key value` and `--flag` — enough for a CLI whose arguments are mostly prose. */
function parseFlags(argv: string[]): Record<string, string | undefined> & { yes?: string } {
  const out: Record<string, string | undefined> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a?.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = ''
    }
  }
  return out
}

/** Everything that is not a flag or a flag's value — i.e. the prose. */
function bareWords(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) i++
      continue
    }
    out.push(a)
  }
  return out
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

  /**
   * §13 — the core is a permanent service, which is exactly why stopping it
   * needed a verb. It is usually started detached by the app, so there is no
   * terminal to interrupt and no obvious way to pick up new code.
   */
  async stop() {
    const c = await connect()
    await c.call('core.shutdown', undefined)
    c.close()
    const freed = await waitForPort(false, 8000)
    out(freed ? C.green('core stopped') : C.yellow('shutdown sent, but the port is still bound'))
    out(C.dim('  dev servers and agents were left running — they outlive the core (§13)'))
  },

  async restart() {
    // Best effort: a core that is not running is not an error here, because
    // "restart" and "start" are the same intent from the user's side.
    try {
      const c = new CoreClient(URL)
      await c.connect()
      await c.call('core.shutdown', undefined)
      c.close()
      await waitForPort(false, 8000)
      out(C.dim('  stopped the running core'))
    } catch {
      out(C.dim('  no core was running'))
    }

    const here = dirname(fileURLToPath(import.meta.url))
    const entry = resolve(here, '..', '..', 'core', 'src', 'index.ts')
    // Detached, so it survives this command exiting — same contract as the app.
    const child = spawn('npx', ['tsx', entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COCKPIT_PORT: String(PORT) },
    })
    child.unref()

    if (!(await waitForPort(true, 30_000))) {
      out(C.red('the core did not come up within 30s'))
      out(C.dim('  run it in the foreground to see why:  cockpit daemon'))
      process.exit(1)
    }
    const c = await connect()
    const st = await c.call('core.status', undefined)
    c.close()
    out(C.green('core restarted') + '  ' + C.dim('pid ' + st.pid + ' · protocol v' + st.protocol.major + '.' + st.protocol.minor))
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

  /**
   * §7 — the layout, from a terminal. `add` takes a folder as it is; this one
   * decides what the folder looks like, and there is only ever one answer:
   * `<dev>/<Project>/<repo>/.git`, never `<dev>/<Project>/.git`.
   */
  async new(args) {
    const flags = parseFlags(args)
    const words = bareWords(args)
    const c = await connect()
    const cfg = await c.call('config.get', undefined)

    const from = flags.from
    const adopt = flags.adopt
    const asIs = 'as-is' in flags

    // The name is what was typed, or what the source is already called.
    let name = words[0] ?? ''
    if (!name && from) name = parseRemote(from)?.repo ?? ''
    if (!name && adopt) name = basename(resolve(adopt))
    if (!name) {
      out(C.red('a project needs a name'))
      out(C.dim('  cockpit new "Cashplannr" [--from owner/repo | --adopt <path>]'))
      process.exit(1)
    }

    const parent = flags.in
      ? resolve(flags.in)
      : (cfg.settings.devRoot ?? cfg.suggestedDevRoot ?? '')
    if (!parent && !(adopt && asIs)) {
      out(C.red('no Dev folder set — where should the project go?'))
      out(C.dim('  cockpit config dev <path>     set it once'))
      out(C.dim('  cockpit new "' + name + '" --in <path>'))
      process.exit(1)
    }

    let source: NewProjectSource
    if (from) {
      const remote = parseRemote(from)
      if (!remote) {
        out(C.red('not a repository URL: ' + from))
        process.exit(1)
      }
      source = {
        kind: 'clone',
        url: from,
        repoName: flags.repo ?? null,
        branch: flags.branch ?? null,
      }
      out(C.dim('cloning ' + remote.url + ' …'))
    } else if (adopt) {
      source = {
        kind: 'folder',
        folder: resolve(adopt),
        // A folder that is itself a repository is the one shape the layout
        // rules out, so by default it moves down a level rather than becoming
        // a root that can never gain a second repository.
        wrap: !asIs,
        repoName: flags.repo ?? null,
      }
    } else {
      source = { kind: 'scratch', repoName: 'empty' in flags ? null : (flags.repo ?? name) }
    }

    const p = await c.call('project.create', {
      name,
      parent: adopt && asIs ? resolve(adopt) : parent,
      source,
    })
    const workspaces = await c.call('workspace.list', { projectId: p.id })
    out(C.green('created ') + C.bold(p.name) + '  ' + C.dim(p.root))
    for (const w of workspaces.filter((w) => w.kind !== 'group')) {
      out('  ' + C.dim(w.kind === 'external' ? 'dir ' : 'repo') + ' ' + w.path.slice(p.root.length + 1))
    }
    out(C.dim('  a second repository is a `git clone` inside ' + p.root))
    c.close()
  },

  /**
   * §7 — a repository joining a project that already exists. `new` lays the
   * layout down once; this is what keeps it true afterwards, and it is the
   * only way a second repository ever lands beside the first rather than
   * somewhere the project cannot see it.
   */
  async repo(args) {
    const [sub, ...rest] = args
    if (sub !== 'add') {
      out('usage: cockpit repo add <name> [--from <url> | --adopt <path>]')
      out(C.dim('             [--project <name>] [--as <folder>] [--branch <b>] [--wrap-root <folder>]'))
      process.exit(1)
    }

    const flags = parseFlags(rest)
    const words = bareWords(rest)
    const c = await connect()

    // Which project: the one named, the one this folder is in, or the only one.
    const projects = await c.call('project.list', undefined)
    if (!projects.length) {
      out(C.red('no project registered. Add one with:  cockpit add <path>'))
      process.exit(1)
    }
    const wanted = flags.project
    const cwd = resolve(process.cwd())
    const project = wanted
      ? projects.find((p) => p.name === wanted || p.root === resolve(wanted))
      : (projects
          .filter((p) => cwd === p.root || cwd.startsWith(p.root + '/'))
          .sort((a, b) => b.root.length - a.root.length)[0] ??
        (projects.length === 1 ? projects[0] : undefined))
    if (!project) {
      out(C.red(wanted ? 'no such project: ' + wanted : 'which project? none contains this folder'))
      out(C.dim('  cockpit repo add <name> --project <' + projects.map((p) => p.name).join('|') + '>'))
      process.exit(1)
    }

    const from = flags.from
    const adopt = flags.adopt
    const name = words[0] ?? ''

    let source: AddRepoSource
    if (from) {
      const remote = parseRemote(from)
      if (!remote) {
        out(C.red('not a repository URL: ' + from))
        process.exit(1)
      }
      source = { kind: 'clone', url: from, repoName: flags.as ?? name ?? null, branch: flags.branch ?? null }
      out(C.dim('cloning ' + remote.url + ' …'))
    } else if (adopt) {
      source = { kind: 'folder', folder: resolve(adopt), repoName: flags.as ?? name ?? null }
    } else {
      if (!name) {
        out(C.red('a repository needs a folder name'))
        out(C.dim('  cockpit repo add api            git init in ' + project.root + '/api'))
        out(C.dim('  cockpit repo add --from owner/api'))
        process.exit(1)
      }
      source = { kind: 'scratch', repoName: flags.as ?? name }
    }

    // §7 — a project whose root is itself a repository has nowhere to put a
    // sibling. Nothing moves somebody's checkout because a default said so, so
    // the name that frees the root is asked for rather than guessed.
    const info = await c.call('project.inspect', { path: project.root })
    if (info.isRepo && !flags['wrap-root']) {
      out(C.red(project.name + ' is itself a repository, so there is nowhere beside it for a second one.'))
      out(C.dim('  It has to move down a level first, which frees the root:'))
      out(C.dim('    ' + project.root + '/' + basename(project.root) + '/   ← the repository that is there now'))
      out(C.dim('    ' + project.root + '/' + (flags.as || name || 'api') + '/   ← the one joining it'))
      out('')
      out('  cockpit repo add ' + (name || '<name>') + ' --wrap-root ' + basename(project.root))
      process.exit(1)
    }

    const r = await c.call('project.addRepo', {
      projectId: project.id,
      source,
      wrapRootAs: flags['wrap-root'] ?? null,
    })
    if (r.wrapped) {
      out(C.yellow('moved ') + project.name + C.dim(' down a level → ') + r.wrapped + '/')
    }
    out(C.green('added ') + C.bold(r.repoPath.slice(project.root.length + 1)) + '  ' + C.dim(r.repoPath))
    if (r.note) out(C.yellow('  the first commit failed: ') + C.dim(r.note))
    if (r.manifestUpdated) out(C.dim('  declared in ' + (r.project.manifestPath ?? 'the manifest')))
    // The repositories, which is what this command is about — not the
    // worktrees hanging off them, and not the project root itself.
    for (const w of await c.call('workspace.list', { projectId: r.project.id })) {
      if (w.kind === 'main' && w.path.startsWith(r.project.root + '/')) {
        out('  ' + C.dim('repo') + ' ' + w.path.slice(r.project.root.length + 1))
      }
    }
    c.close()
  },

  /** §15 — the machine-local settings, read and written from a terminal too. */
  async config(args) {
    const c = await connect()
    const [key, ...rest] = args
    const value = rest.join(' ').trim()

    if (!key) {
      const v = await c.call('config.get', undefined)
      out('')
      out(C.bold('  dev  ') + (v.settings.devRoot ?? C.dim('unset')))
      if (!v.settings.devRoot && v.suggestedDevRoot) {
        out(C.dim('       your projects sit in ' + v.suggestedDevRoot + ' — cockpit config dev ' + v.suggestedDevRoot))
      }
      out(C.bold('  ide  ') + v.settings.ide)
      out('')
      out(C.dim('  one folder per project, one folder per repo inside it:'))
      out(C.dim('  <dev>/<Project>/<repo>/.git   — never <dev>/<Project>/.git'))
      out('')
      c.close()
      return
    }

    if (key === 'dev' || key === 'devRoot') {
      const v = await c.call('config.set', { devRoot: value || null })
      out(C.green('dev folder ') + (v.settings.devRoot ?? C.dim('unset')))
    } else if (key === 'ide') {
      if (!value) {
        out(C.red('usage: cockpit config ide <command>'))
        process.exit(1)
      }
      const v = await c.call('config.set', { ide: value })
      out(C.green('ide ') + v.settings.ide)
    } else {
      out(C.red('unknown setting: ' + key))
      out(C.dim('  cockpit config [dev <path> | ide <command>]'))
      process.exit(1)
    }
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
    if (r.conflict) {
      // Not a failure: the plan reached something only a person can decide.
      out(C.yellow(r.conflict.repo + ': ' + r.conflict.kind + ' stopped on a conflict'))
      out(C.dim('  cockpit conflict show ' + r.conflict.repo))
    } else {
      out(r.ok ? C.green('applied') : C.red('failed'))
    }
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

  /**
   * §16 — "revue humaine du diff avant tout commit". `cockpit diff` is the
   * review; this is the commit it was a review of, across every repository of
   * the feature at once.
   */
  async commit(args) {
    const c = await connect()
    const flags = parseFlags(args)
    const message = args.filter((a) => !a.startsWith('--'))[0]
    if (!message) {
      out('usage: cockpit commit "<message>" [--staged] [--at <feature|workspace>] [--yes]')
      out(C.dim('  --staged commits only what is already staged; the default stages everything'))
      process.exit(1)
    }
    const all = flags.staged === undefined

    // A feature by slug, or the workspace the shell is standing in.
    const features = await c.call('feature.list', {})
    const f = flags.at ? features.find((x) => x.slug === flags.at || x.name === flags.at) : null
    const target = f
      ? { featureId: f.id }
      : { workspaceIds: [(await pickWorkspace(c, flags.at)).id] }

    const res = await c.call('git.commit', { ...target, message, all })
    for (const r of res.preview) {
      const n = all ? r.staged + r.unstaged : r.staged
      out(
        '  ' + (r.willCommit ? C.green('+') : C.dim('·')) + ' ' + r.repo.padEnd(16) +
          C.dim((r.branch ?? '—') + '  ' + n + ' file(s)') +
          (r.conflicted ? C.red('  ' + r.conflicted + ' conflicted') : ''),
      )
    }
    if (!res.ok || !res.plan) {
      out(C.red(res.detail))
      c.close()
      process.exit(1)
    }
    printPlan(res.plan)
    if (flags.yes === undefined) {
      out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + res.plan.planId))
      c.close()
      return
    }
    const applied = await c.call('git.apply', { planId: res.plan.planId })
    out(applied.output)
    out(applied.ok ? C.green('committed') : C.red('stopped'))
    c.close()
    process.exit(applied.ok ? 0 : 1)
  },

  /**
   * §3.7 — the three verbs that end a stopped rebase. Without these the CLI
   * could start one and not finish it, which §15 does not allow: everything
   * the window can do is doable here.
   */
  async conflict(args) {
    const c = await connect()
    const sub = args[0] ?? 'show'

    if (sub === 'ls' || sub === 'list') {
      const all = await c.call('workspace.list', {})
      const stuck = all.filter((w) => w.git?.operation)
      if (!stuck.length) out(C.dim('  nothing in progress'))
      for (const w of stuck) {
        const o = w.git!.operation!
        out('')
        out('  ' + C.yellow('◆') + ' ' + C.bold(w.name) + '  ' + C.dim(o.kind + (o.onto ? ' onto ' + o.onto : '')))
        printOperation(o)
      }
      c.close()
      return
    }

    // A worktree and its main checkout share a name, so `conflict continue
    // bravo` is ambiguous — except that only one of them can be mid-rebase.
    // Preferring that one is not a guess, it is the only workable answer.
    const w = await pickConflicted(c, args[1])
    if (sub === 'show') {
      const o = await c.call('git.state', { workspaceId: w.id })
      if (!o) {
        out(C.dim('  nothing in progress in ' + w.name))
        c.close()
        return
      }
      out('')
      out('  ' + C.bold(o.kind) + (o.branch ? ' ' + o.branch : '') + (o.onto ? C.dim(' onto ' + o.onto) : ''))
      printOperation(o)
      out('')
      out(C.dim('  cockpit conflict continue | skip | abort'))
      c.close()
      return
    }

    if (sub === 'mark') {
      const o = await c.call('git.state', { workspaceId: w.id })
      const r = await c.call('git.stage', { workspaceId: w.id, paths: o?.conflictedPaths ?? [] })
      out(r.ok ? C.green(r.detail) : C.red(r.detail))
      c.close()
      return
    }

    if (sub !== 'continue' && sub !== 'abort' && sub !== 'skip') {
      out('usage: cockpit conflict [show|ls|continue|skip|abort|mark] [workspace]')
      process.exit(1)
    }

    const r = await c.call('git.resolve', { workspaceId: w.id, action: sub })
    if (!r.ok && r.unresolved.length) {
      out(C.red(r.detail))
      for (const p of r.unresolved) out('    ' + C.red('<<<') + ' ' + p)
      out(C.dim('    resolve them, or:  cockpit conflict mark'))
      c.close()
      process.exit(1)
    }
    out(r.ok ? C.green(r.detail) : C.red(r.detail))
    if (r.operation) printOperation(r.operation)
    c.close()
    process.exit(r.ok ? 0 : 1)
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

  /**
   * §10 — the database each worktree of a feature would get, and whether the
   * client needed to make it is even installed.
   */
  async db(args) {
    const c = await connect()
    const flags = parseFlags(args)
    const slug = slugify(flags.slug ?? args[0] ?? 'preview')
    const projects = await c.call('project.list', undefined)
    const here = await pickWorkspace(c, undefined)
    const project = projects.find((x) => x.id === here.projectId) ?? projects[0]
    if (!project) {
      out(C.red('no project registered'))
      process.exit(1)
    }
    const res = await c.call('database.preview', { projectId: project.id, slug })
    if (!res.length) {
      out(C.dim('  no repository here declares a database'))
      c.close()
      return
    }
    out('')
    for (const d of res) {
      out('  ' + C.bold(d.repo) + '  ' + C.dim(d.engine))
      if (d.to) out('    ' + C.dim(d.from) + ' ' + C.dim('→') + ' ' + C.cyan(d.to))
      out('    ' + C.dim(d.detail))
      if (d.missingTools.length) {
        out('    ' + C.yellow('! ' + d.missingTools.join(', ') + ' not on PATH'))
      }
    }
    out('')
    c.close()
  },

  /**
   * §7 — what a worktree for this feature name would be missing, and what in
   * it must differ from the main checkout. Creates nothing; it is the answer
   * to "why did my worktree not boot" before the worktree exists.
   */
  async seed(args) {
    const c = await connect()
    const flags = parseFlags(args)
    const slug = slugify(flags.slug ?? args[0] ?? 'preview')
    const here = await pickWorkspace(c, undefined)
    const projects = await c.call('project.list', undefined)
    const project = projects.find((x) => x.id === here.projectId) ?? projects[0]
    if (!project) {
      out(C.red('no project registered'))
      process.exit(1)
    }
    const res = await c.call('worktree.seedPreview', { projectId: project.id, slug })
    const carrying = res.filter((x) => x.files.length)
    if (!carrying.length) {
      out(C.dim('  nothing to carry — every repository checks out all it needs'))
      for (const p of res) for (const sk of p.skipped) out(C.dim('  ' + p.repo + '/' + sk.path + ' — ' + sk.reason))
      c.close()
      return
    }
    printSeed(carrying, false)
    c.close()
  },

  /**
   * §4 — the durable unit of work. Open it once, park it, come back on
   * Thursday. Everything the window does with a feature is here too (§15).
   */
  async feature(args) {
    const c = await connect()
    const sub = args[0] ?? 'ls'

    const pickFeature = async (hint?: string) => {
      const all = await c.call('feature.list', { includeArchived: true })
      if (!all.length) {
        out(C.dim('no feature open. Start one with:  cockpit feature open "<name>"'))
        process.exit(1)
      }
      const f = hint
        ? all.find((x) => x.id === hint || x.slug === hint || x.name === hint)
        : all.find((x) => x.state === 'live') ?? all[0]
      if (!f) {
        out(C.red('no feature matching "' + hint + '"'))
        process.exit(1)
      }
      return f
    }

    if (sub === 'ls' || sub === 'list') {
      const all = args.includes('--all')
      const featues = await c.call('feature.list', { includeArchived: all })
      const workspaces = await c.call('workspace.list', {})
      if (!featues.length) out(C.dim('  no feature'))
      for (const f of featues) {
        const dot = f.state === 'live' ? C.green('●') : f.state === 'archived' ? C.dim('○') : C.yellow('◐')
        const cost = f.costUsd > 0 ? C.dim(' · $' + f.costUsd.toFixed(2)) : ''
        const origin = f.derived ? C.dim(' · inferred') : ''
        out('')
        out('  ' + dot + ' ' + C.bold(f.name) + '  ' + C.dim(f.slug + ' · ' + f.ceremony) + cost + origin)
        if (f.rootPath) out('    ' + C.dim(f.rootPath))
        for (const w of workspaces.filter((w) => f.workspaceIds.includes(w.id) && w.kind !== 'group')) {
          out('    ' + workspaceLine(w))
        }
      }
      if (!all) {
        const closed = (await c.call('feature.list', { includeArchived: true })).filter(
          (f) => f.state === 'archived',
        ).length
        if (closed) out(C.dim('  ' + closed + ' closed — cockpit feature ls --all'))
      }
      out('')
      c.close()
      return
    }

    if (sub === 'reopen') {
      const f = await pickFeature(args[1])
      const res = await c.call('feature.reopen', { featureId: f.id })
      if (!res.ok) {
        out(C.red(res.detail))
        c.close()
        process.exit(1)
      }
      out(C.green('reopened ') + C.bold(f.name) + '  ' + C.dim(res.detail))
      c.close()
      return
    }

    /**
     * §16 — close archives, delete drops the record for good. Keeping them as
     * separate verbs is the point: the safe one is the short one.
     */
    if (sub === 'delete' || sub === 'rm') {
      const f = await pickFeature(args[1])
      const branches = args.includes('--branches')
      const keep = args.includes('--keep-worktrees')
      const res = await c.call('feature.delete', {
        featureId: f.id,
        removeWorktrees: !keep,
        deleteBranches: branches,
        // §10 — its own flag, and never implied by --branches: a branch that
        // is merged can be recreated from the remote, a dropped database
        // cannot be recreated from anything.
        dropDatabases: args.includes('--databases'),
        force: args.includes('--force'),
      })
      if (!res.ok) {
        out(C.red('refusing: ') + res.detail)
        c.close()
        process.exit(1)
      }
      for (const w of res.warnings) out('  ' + C.yellow('! ' + w))
      if (res.plan) {
        printPlan(res.plan)
        out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + res.plan.planId))
      } else {
        out(C.green(res.detail))
      }
      c.close()
      return
    }

    if (sub === 'open') {
      const name = args[1]
      if (!name) {
        out('usage: cockpit feature open "<name>" [--repos a,b] [--base main] [--ceremony C2|C3]')
        process.exit(1)
      }
      const flags = parseFlags(args.slice(2))
      const projects = await c.call('project.list', undefined)
      const here = await pickWorkspace(c, undefined)
      const project = projects.find((x) => x.id === here.projectId) ?? projects[0]
      if (!project) {
        out(C.red('no project registered'))
        process.exit(1)
      }
      const workspaces = await c.call('workspace.list', { projectId: project.id })
      const wanted = flags.repos?.split(',').map((x) => x.trim()).filter(Boolean)
      const repoWorkspaceIds = wanted?.length
        ? workspaces.filter((w) => w.kind === 'main' && wanted.includes(w.name)).map((w) => w.id)
        : undefined

      const ceremony = (flags.ceremony as 'C1' | 'C2' | 'C3') ?? 'C3'

      // §7 — what git will not check out. Shown with the plan so the whole of
      // what is about to happen is on one screen, and passed only when the
      // user said yes: a detected proposal nobody saw never writes to a .env.
      const slug = slugify(name)
      const seed =
        ceremony === 'C1' || flags['no-seed'] !== undefined
          ? []
          : await c
              .call('worktree.seedPreview', { projectId: project.id, repoWorkspaceIds, slug })
              .catch(() => [])
      const carrying = seed.filter((x) => x.files.length)

      const cloneDatabase = ceremony !== 'C1' && flags['clone-db'] !== undefined
      const { plan } = await c.call('feature.open', {
        projectId: project.id,
        name,
        ceremony,
        repoWorkspaceIds,
        base: flags.base,
        ...(carrying.length
          ? { seed: carrying, rememberSeed: flags['no-remember'] === undefined }
          : {}),
        ...(cloneDatabase ? { cloneDatabase: true } : {}),
      })
      printPlan(plan)
      if (carrying.length) printSeed(carrying, flags['no-remember'] === undefined)

      // §10 — offered rather than assumed. Copying a database is slow and
      // costs the disk again, so it is the user's call, but a worktree
      // silently sharing one is the collision no folder isolation prevents.
      if (!cloneDatabase && ceremony !== 'C1') {
        const dbs = await c
          .call('database.preview', { projectId: project.id, repoWorkspaceIds, slug })
          .catch(() => [])
        const shared = dbs.filter((d) => d.engine !== 'sqlite' && d.to)
        if (shared.length) {
          out(
            C.yellow('  ! ') +
              shared.map((d) => d.repo + ' will share ' + d.from).join(', ') +
              C.dim(' — a migration in this worktree reaches the others'),
          )
          out(C.dim('    --clone-db to give each worktree its own copy'))
        }
      }
      if (flags.yes === undefined) {
        out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + plan.planId))
        if (carrying.length) {
          // The seed rides on `feature.open`, not on the plan id, so applying
          // the plan by hand later would create worktrees and carry nothing.
          out(C.yellow('  ! the local config above is carried only by `feature open --yes`'))
        }
        c.close()
        return
      }
      const res = await c.call('git.apply', { planId: plan.planId })
      out(res.output)
      out(res.ok ? C.green('feature open') : C.red('failed — nothing was left behind'))
      c.close()
      return
    }

    if (sub === 'land') {
      const f = await pickFeature(args[1])
      const res = await c.call('feature.land', {
        featureId: f.id,
        push: args.includes('--push'),
        ...(args.indexOf('--base') >= 0 ? { base: args[args.indexOf('--base') + 1] ?? '' } : {}),
      })
      if (!res.ok || !res.plan) {
        out(C.red(res.detail))
        c.close()
        process.exit(1)
      }
      printPlan(res.plan)
      if (!args.includes('--yes')) {
        out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + res.plan.planId))
        c.close()
        return
      }
      const applied = await c.call('git.apply', { planId: res.plan.planId })
      out(applied.output)
      if (applied.conflict) {
        out(C.yellow(applied.conflict.repo + ': the merge stopped on a conflict'))
        out(C.dim('  cockpit conflict show ' + applied.conflict.repo + '   then:  cockpit conflict continue'))
        out(C.dim('  what already merged was kept; run land again when it is resolved'))
      } else {
        out(applied.ok ? C.green('landed') : C.red('stopped'))
        if (applied.ok && !args.includes('--push')) {
          out(C.dim('  local only — push the base branch, or use --push next time'))
        }
      }
      c.close()
      process.exit(applied.ok || applied.conflict ? 0 : 1)
    }

    if (sub === 'rebase') {
      const f = await pickFeature(args[1])
      const baseIdx = args.indexOf('--base')
      const res = await c.call('feature.rebase', {
        featureId: f.id,
        ...(baseIdx >= 0 ? { base: args[baseIdx + 1] ?? '' } : {}),
      })
      if (!res.ok || !res.plan) {
        out(C.red(res.detail))
        c.close()
        process.exit(1)
      }
      printPlan(res.plan)
      if (!args.includes('--yes')) {
        out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + res.plan.planId))
        c.close()
        return
      }
      const applied = await c.call('git.apply', { planId: res.plan.planId })
      out(applied.output)
      if (applied.conflict) {
        out(C.yellow(applied.conflict.repo + ': ' + applied.conflict.kind + ' stopped on a conflict'))
        out(C.dim('  cockpit conflict show ' + applied.conflict.repo))
      } else {
        out(applied.ok ? C.green('rebased') : C.red('stopped'))
      }
      c.close()
      return
    }

    if (sub === 'live' || sub === 'activate') {
      const f = await pickFeature(args[1])
      const res = await c.call('feature.activate', { featureId: f.id, force: args.includes('--force') })
      if (!res.ok) {
        for (const x of res.conflicts) out('  ' + C.yellow('! ' + x))
        out(C.red(res.detail))
        c.close()
        process.exit(1)
      }
      for (const x of res.parked) out(C.dim('  parked ' + x))
      out(C.green('live ') + C.bold(f.name))
      if (res.detail) out(C.dim(res.detail.split('\n').map((l) => '  ' + l).join('\n')))
      c.close()
      return
    }

    if (sub === 'park') {
      const f = await pickFeature(args[1])
      const res = await c.call('feature.park', { featureId: f.id })
      out(C.green('parked ') + C.bold(f.name) + '  ' + C.dim(res.detail))
      c.close()
      return
    }

    if (sub === 'close') {
      const f = await pickFeature(args[1])
      const remove = args.includes('--remove')
      const res = await c.call('feature.close', { featureId: f.id, removeWorktrees: remove })
      if (!res.ok) {
        out(C.red('refusing: ') + res.detail)
        c.close()
        process.exit(1)
      }
      if (res.plan) {
        printPlan(res.plan)
        out(C.dim('  nothing has run. Apply it with:  cockpit apply ' + res.plan.planId))
      } else {
        out(C.green('closed ') + C.bold(f.name) + '  ' + C.dim(res.detail))
      }
      c.close()
      return
    }

    out('usage: cockpit feature <command>')
    out('  ls [--all]                    every feature; --all includes closed ones')
    out('  open "<name>"                 [--repos a,b --base main --ceremony C3 --yes]')
    out('  live [name] [--force]         bring its runtimes up')
    out('  park [name]                   servers down, worktrees kept')
    out('  close [name] [--remove]       archive it; reversible with reopen')
    out('  reopen [name]                 bring a closed one back')
    out('  delete [name]                 drop the record for good')
    out('      --branches                also delete the branch in every repo')
    out('      --keep-worktrees          leave the checkouts on disk')
    out('      --force                   proceed over UNMERGED branches')
    c.close()
    process.exit(1)
  },

  async agent(args) {
    const c = await connect()
    const sub = args[0]
    if (sub === 'list') {
      const sessions = await c.call('agent.list', undefined)
      for (const s of sessions) {
        // §6 — the mark that says "this conversation is still there".
        const mark = s.resumable ? C.green(' ↻') : '  '
        out(
          '  ' + C.dim(s.id.slice(-6)) + mark + ' ' + C.mag(s.engine.padEnd(8)) + s.status.padEnd(9) +
            C.dim(s.turns + ' turns · $' + s.costUsd.toFixed(2)) + '  ' + C.dim(s.paths.join(', ')),
        )
        if (s.prompt) out('         ' + C.dim(s.prompt.replace(/\s+/g, ' ').slice(0, 76)))
      }
      out('')
      out(C.dim('  ↻ = resumable:  cockpit agent resume <id> "<what next>"'))
      c.close()
      return
    }

    if (sub === 'resume') {
      const id = args[1]
      const prompt = args.slice(2).join(' ')
      if (!id || !prompt) {
        out('usage: cockpit agent resume <session-id> "<what next>"')
        process.exit(1)
      }
      const sessions = await c.call('agent.list', undefined)
      const prev = sessions.find((x) => x.id === id || x.id.endsWith(id))
      if (!prev) {
        out(C.red('no session matching "' + id + '"'))
        process.exit(1)
      }
      const r = await c.call('agent.resume', { sessionId: prev.id, prompt })
      if ('denied' in r) {
        out(C.red('denied: ') + r.reason)
        c.close()
        process.exit(1)
      }
      out(C.green('resumed ') + r.sessionId + C.dim(' · the memory is re-read, the conversation continues'))
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
    const prompt = bareWords(args.slice(1)).join(' ')
    if (!prompt) {
      out('usage: cockpit agent <engine> <prompt>   |   cockpit agent list | engines')
      process.exit(1)
    }
    const flags = parseFlags(args.slice(1))
    const w = await pickWorkspace(c, flags.at)
    const r = await c.call('agent.start', {
      engine,
      workspaceIds: [w.id],
      prompt,
      ...(flags.feature ? { featureId: flags.feature } : {}),
    })
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
    out(C.bold('  projects') + C.dim('   — <dev>/<Project>/<repo>/.git, never <dev>/<Project>/.git'))
    out('    new "<name>"                a project folder + its first repo  [--empty]')
    out('        --from owner/repo       clone into <dev>/<name>/<repo>  [--branch b]')
    out('        --adopt <path>          move an existing repo into a project of its own')
    out('        --adopt <path> --as-is  or register that folder where it stands')
    out('        --in <path>             somewhere other than the Dev folder')
    out('    repo add <name>             a repository beside the ones already there')
    out('        --from owner/repo       clone it in instead  [--branch b]')
    out('        --adopt <path>          move a folder already on this machine in')
    out('        --wrap-root <folder>    when the project root is itself a repo: move it down first')
    out('    config [dev <path>]         the Dev folder every project lands in')
    out('    init [path]                 write a starter cockpit.yaml')
    out('    add <path>                  register a project as it is')
    out('    forget <name>               unregister a project')
    out('')
    out(C.bold('  work'))
    out('    diff [workspace]            changed files, split human / agent')
    out('    search <query>              full-text across every repo at once')
    out('    commit "<msg>"              stage and commit, every repo of the feature at once')
    out('    plan <op> [ws] [--name X]   preview a git operation')
    out('    apply <planId>              run a previewed plan')
    out('    undo [workspace]            roll back to the last restore point')
    out('    seed [slug]                 the local config a worktree would be missing')
    out('    db [slug]                   the database each worktree would get')
    out('    conflict [show|ls]          what a stopped rebase left behind')
    out('    conflict continue|skip|abort   end it  [mark = the markers belong there]')
    out('    up | down [workspace]       start / stop the runtime')
    out('')
    out(C.bold('  features') + C.dim('   — the durable unit of work: multi-repo, multi-day'))
    out('    feature ls                  every feature, live or parked')
    out('    feature open "<name>"        one plan, a worktree per repo  [--repos a,b --base main]')
    out('        --no-seed / --no-remember   skip the local config, or do not record the answer')
    out('        --clone-db                  give each worktree its own copy of the database')
    out('    feature rebase [name]       every repo onto its base, one plan  [--base X --yes]')
    out('    feature land [name]         merge it ONTO the base, in every repo  [--push --yes]')
    out('    feature live [name]         bring its runtimes up  [--force to park whatever blocks it]')
    out('    feature park [name]         servers down, worktrees kept')
    out('    feature close [name]        archive it  [--remove to drop the worktrees too]')
    out('    feature reopen [name]       bring a closed one back')
    out('    feature delete [name]       drop the record for good  [--branches --databases --force]')
    out('')
    out(C.bold('  agents & memory'))
    out('    agent engines               which engines are installed')
    out('    agent list                  sessions; ↻ marks the resumable ones')
    out('    agent <engine> <prompt>     start a session here  [--at ws --feature id]')
    out('    agent resume <id> <prompt>  pick yesterday\'s conversation back up')
    out('    memory show [workspace]     read the feature memory')
    out('    memory promote <s> <text>   push a decision into the memory')
    out('')
    out(C.bold('  service'))
    out('    daemon                      run the core in the foreground')
    out('    restart                     stop it and start it again, detached')
    out('    stop                        stop it; dev servers keep running')
    out(C.dim('    (restart after changing core code — the window will say so too)'))
    out('')
  },
}

/** §7 — the local config a worktree cannot check out, and what changes in it. */
function printSeed(proposals: SeedProposal[], remembering: boolean): void {
  out('')
  out(C.bold('local config') + C.dim('  — what git will not check out into a worktree'))
  for (const p of proposals) {
    out('')
    out('  ' + C.bold(p.repo) + '  ' + C.dim(p.source === 'manifest' ? 'declared in cockpit.yaml' : 'detected'))
    for (const f of p.files) {
      out('    ' + C.green('+') + ' ' + f.path + C.dim('  ' + f.bytes + ' B'))
      for (const ch of f.changes) {
        out(
          '        ' + ch.key + ' ' +
            (ch.from ? C.dim(ch.from) + ' ' : '') +
            C.dim('→') + ' ' + C.cyan(ch.to),
        )
        out('          ' + C.dim(ch.reason))
      }
    }
    for (const sk of p.skipped) out('    ' + C.dim('· ' + sk.path + ' — ' + sk.reason))
  }
  if (remembering && proposals.some((p) => p.source !== 'manifest' && p.manifestPath)) {
    out('')
    out(C.dim('  this will be written into cockpit.yaml — the next feature carries it without asking'))
    out(C.dim('  (--no-remember to decide again next time, --no-seed to carry nothing)'))
  }
  out('')
}

function printOperation(o: {
  step: number | null
  total: number | null
  conflictedPaths: string[]
  unresolvedPaths: string[]
}): void {
  if (o.step && o.total) out('    ' + C.dim('commit ' + o.step + ' of ' + o.total))
  for (const p of o.conflictedPaths) {
    const stillOpen = o.unresolvedPaths.includes(p)
    out('    ' + (stillOpen ? C.red('<<<') : C.green(' ✓ ')) + ' ' + p)
  }
  if (o.conflictedPaths.length && !o.unresolvedPaths.length) {
    out('    ' + C.dim('no markers left — continue will stage these for you'))
  }
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

/**
 * §3.5 again, for the conflict verbs: among the workspaces a hint matches,
 * the one holding a stopped operation is the one meant. Falls through to the
 * ordinary rule when nothing is stuck, so `conflict show` on a clean repo
 * still says so about the right repo.
 */
async function pickConflicted(c: CoreClient, hint?: string): Promise<Workspace> {
  const all = await c.call('workspace.list', {})
  const stuck = all.filter((w) => w.git?.operation)
  const matches = (w: Workspace) =>
    !hint || w.name === hint || w.id === hint || w.path.endsWith('/' + hint)

  const hit = stuck.filter(matches)
  if (hit.length === 1) return hit[0]!
  if (hit.length > 1) {
    out(C.red('several workspaces are mid-operation:'))
    for (const w of hit) out('    ' + w.name + '  ' + C.dim(w.path))
    out(C.dim('  name one by its path'))
    process.exit(1)
  }
  return pickWorkspace(c, hint)
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
