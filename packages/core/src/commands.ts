import type { CommandDecl, CommandRunResult, DeclaredCommand, ManifestV1, Workspace } from '@cockpit/shared'
import { findManifest, readManifest } from './detect.js'
import { getProject, requireWorkspace } from './registry.js'
import { append } from './journal.js'
import * as sup from './supervisor.js'
import { baseLookup, hostWorkspaceFor, resolveEnvironment } from './runtime/declared.js'
import { fill, splitArgs } from './runtime/template.js'

/**
 * §8 — the one-shot half of the declared model: build, release, migrate.
 *
 * Same file, same placeholders, same output surface as a server — the only
 * difference is that nobody waits for it to stay up. It exists because the
 * thing people actually do all day was the one thing the window had no place
 * for: every project has four or five commands that matter, they were retyped
 * into a terminal every time, and retyping is where the wrong flag and the
 * wrong directory come from.
 *
 * It runs in the environment it was launched from, which is the whole point of
 * putting it here rather than in a shell: `pnpm build` pressed on a topic
 * builds *that* worktree, with that topic's wiring, without anyone having to
 * remember which folder they are standing in.
 */

function manifestFor(ws: Workspace): ManifestV1 | null {
  const project = getProject(ws.projectId)
  const path = project?.manifestPath ?? (project ? findManifest(project.root) : null)
  return path ? readManifest(path).manifest : null
}

function inputsOf(decl: CommandDecl): DeclaredCommand['inputs'] {
  return Object.entries(decl.ask ?? {}).map(([key, label]) => ({ key, label: String(label) }))
}

/** Every command this environment can run, in declaration order. */
export function listCommands(ws: Workspace): DeclaredCommand[] {
  const declared = manifestFor(ws)?.commands
  if (!declared) return []

  const out: DeclaredCommand[] = []
  for (const [name, decl] of Object.entries(declared)) {
    const host = hostWorkspaceFor(ws, decl.repo)
    if (!host) continue
    out.push({
      name,
      workspaceId: host.ws.id,
      cwd: host.ws.path,
      cmd: decl.cmd,
      inputs: inputsOf(decl),
      confirm: decl.confirm === true ? 'Run ' + name + '?' : decl.confirm ? String(decl.confirm) : null,
      fellBack: host.fellBack,
    })
  }
  return out
}

/**
 * Run one, with the answers to its questions.
 *
 * The cross-server table is only built when the line asks for it: resolving an
 * environment allocates ports, and `pnpm build` has no business burning a port
 * number that then lives in the config file forever.
 */
export async function runCommand(
  workspaceId: string,
  name: string,
  answers: Record<string, string> = {},
): Promise<CommandRunResult> {
  const ws = requireWorkspace(workspaceId)
  const decl = manifestFor(ws)?.commands?.[name]
  if (!decl) return { ok: false, detail: 'no command named ' + name, procId: null, cmd: '', cwd: '' }

  const host = hostWorkspaceFor(ws, decl.repo)
  if (!host) {
    return { ok: false, detail: 'no checkout of ' + decl.repo + ' here', procId: null, cmd: decl.cmd, cwd: '' }
  }

  const base = baseLookup(host.ws)
  const wantsServers = /\{\{[\w-]+\.(url|port)\}\}/.test(decl.cmd)
  const servers = wantsServers ? await resolveEnvironment(ws) : []

  const { text, missing } = fill(decl.cmd, (key) => {
    if (key in answers) return answers[key] ?? null
    const own = base(key)
    if (own !== null) return own
    const dot = key.indexOf('.')
    if (dot < 0) return null
    const target = servers.find((s) => s.name === key.slice(0, dot))
    const field = key.slice(dot + 1)
    if (!target) return null
    if (field === 'url') return target.url
    if (field === 'port') return target.port === null ? null : String(target.port)
    return null
  })

  // An unanswered question is the caller's bug, not something to paper over:
  // running `pnpm release {{version}}` verbatim would publish nonsense.
  if (missing.length) {
    return {
      ok: false,
      detail: 'nothing named ' + missing.map((m) => '{{' + m + '}}').join(', '),
      procId: null,
      cmd: text,
      cwd: host.ws.path,
    }
  }

  const argv = splitArgs(text)
  if (!argv.length) {
    return { ok: false, detail: 'empty command', procId: null, cmd: text, cwd: host.ws.path }
  }

  const proc = sup.start({
    workspaceId: host.ws.id,
    label: name,
    cwd: host.ws.path,
    command: argv[0]!,
    args: argv.slice(1),
  })
  append({
    type: 'command.run',
    workspaceId: host.ws.id,
    actor: { kind: 'human' },
    payload: { name, cmd: text, cwd: host.ws.path, procId: proc.id },
  })
  return { ok: true, detail: 'running ' + name, procId: proc.id, cmd: text, cwd: host.ws.path }
}
