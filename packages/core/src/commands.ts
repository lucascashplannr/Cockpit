import { basename } from 'node:path'
import type { CommandDecl, CommandRunResult, DeclaredCommand, ManifestV1, Workspace } from '@cockpit/shared'
import { findManifest, readManifest } from './detect.js'
import { getProject, requireWorkspace } from './registry.js'
import { append } from './journal.js'
import * as sup from './supervisor.js'
import { baseLookup, hostWorkspaceFor, resolveEnvironment, serversOf } from './runtime/declared.js'
import * as runtime from './runtime/index.js'
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

/**
 * Every command you can press *here*, in declaration order.
 *
 * A command is declared for a repository or for the project, and that is not
 * only where it is written — it is where it can be pressed. A `repo:` command
 * is offered in checkouts of that repository and nowhere else; a command with
 * no `repo:` belongs to the project, so it is offered in the project's own
 * folder — a topic's folder inside a topic — and not under each repository,
 * where it made a repository that declares nothing look as if it did.
 *
 * Without the first half of that rule `hostWorkspaceFor`'s fallback answered
 * for everything: a `build` declared for the API resolved to the API's main
 * checkout from *any* repository in the project, so a repository with no
 * commands of its own still carried a Run button, listing another
 * repository's — and pressing it ran that other repository's build, from a bar
 * whose name said you were somewhere else. The same fallback is right inside
 * the repository it belongs to (a topic that only branches the frontend still
 * builds the unbranched API), which is why it is a filter here rather than a
 * change there. `servers:` has been scoped this way since capabilities were
 * detected (`detectCapabilities`); this is commands catching up.
 */
export function listCommands(ws: Workspace): DeclaredCommand[] {
  const declared = manifestFor(ws)?.commands
  if (!declared) return []

  const out: DeclaredCommand[] = []
  for (const [name, decl] of Object.entries(declared)) {
    const repo = decl.repo ? basename(decl.repo) : ''
    if (repo !== ws.repoName) continue
    const host = hostWorkspaceFor(ws, decl.repo)
    if (!host) continue
    out.push({
      name,
      repo,
      workspaceId: host.ws.id,
      cwd: host.ws.path,
      cmd: decl.cmd ?? '',
      runs: decl.runs ?? [],
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
  if (!decl) return { ok: false, detail: 'no command named ' + name, touched: [], procId: null, cmd: '', cwd: '' }

  const host = hostWorkspaceFor(ws, decl.repo)
  if (!host) {
    return { ok: false, detail: 'no checkout of ' + decl.repo + ' here', touched: [], procId: null, cmd: decl.cmd ?? '', cwd: '' }
  }

  // §8 — a list, run in order. The caller waits, the same way it waits for a
  // server to answer: the output is streaming into the log pane meanwhile, so
  // waiting is not the same as being blind.
  if (decl.runs?.length) return runSequence(ws, name, decl.runs, answers, host.ws.path)

  const line = decl.cmd ?? ''
  const base = baseLookup(host.ws)
  const wantsServers = /\{\{[\w-]+\.(url|port)\}\}/.test(line)
  const servers = wantsServers ? await resolveEnvironment(ws) : []

  const { text, missing } = fill(line, (key) => {
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
      touched: [],
      procId: null,
      cmd: text,
      cwd: host.ws.path,
    }
  }

  const argv = splitArgs(text)
  if (!argv.length) {
    return { ok: false, detail: 'empty command', touched: [], procId: null, cmd: text, cwd: host.ws.path }
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
  return { ok: true, detail: 'running ' + name, touched: [host.ws.id], procId: proc.id, cmd: text, cwd: host.ws.path }
}

/**
 * §8 — run a `runs:` list, in order, stopping at the first failure.
 *
 * A name in the list is a command or a server, and the difference is what
 * "done" means: a command is done when it exits, a server when it is up. That
 * is the only reason this has two branches — the user writing `up: { runs:
 * [api, web] }` should not have to say which kind each one is.
 */
async function runSequence(
  ws: Workspace,
  name: string,
  steps: string[],
  answers: Record<string, string>,
  cwd: string,
): Promise<CommandRunResult> {
  const manifest = manifestFor(ws)
  const done: string[] = []
  const touched = new Set<string>()

  for (const step of steps) {
    if (manifest?.commands?.[step]) {
      const res = await runCommand(ws.id, step, answers)
      if (!res.ok) {
        return { ok: false, detail: failure(done, step, res.detail), touched: [...touched], procId: null, cmd: name, cwd }
      }
      for (const id of res.touched) touched.add(id)
      const code = res.procId ? await sup.waitFor(res.procId) : 0
      if (code !== 0) {
        return {
          ok: false,
          // A null code is a step that never became a process — a command line
          // whose first word is not a program, most often. Saying "exited with
          // code ?" about it is the wrong sentence twice over, and the right
          // one is the line the spawn itself wrote.
          detail: failure(done, step, whyItEnded(res.procId, code)),
          touched: [...touched],
          procId: res.procId,
          cmd: name,
          cwd,
        }
      }
      done.push(step)
      continue
    }

    if (manifest?.servers?.[step]) {
      // Start the workspace that hosts it, which is what `runtime.up` takes.
      const all = await resolveEnvironment(ws)
      const target = all.find((s) => s.name === step)
      const hostWs = target ? getWorkspaceOf(target.workspaceId) : null
      if (!hostWs) {
        return { ok: false, detail: failure(done, step, 'nowhere to run it'), touched: [...touched], procId: null, cmd: name, cwd }
      }
      // Already up is success, not a second start: pressing `up` twice should
      // be boring rather than an error or a duplicate process.
      const running = (await serversOf(hostWs)).length && (await runtime.health(hostWs)).status === 'up'
      const res = running ? { ok: true, detail: 'already up' } : await runtime.up(hostWs)
      touched.add(hostWs.id)
      if (!res.ok) {
        return { ok: false, detail: failure(done, step, res.detail), touched: [...touched], procId: null, cmd: name, cwd }
      }
      done.push(step)
      continue
    }

    return { ok: false, detail: failure(done, step, 'nothing named ' + step), touched: [...touched], procId: null, cmd: name, cwd }
  }

  return { ok: true, detail: done.join(', then '), touched: [...touched], procId: null, cmd: name, cwd }
}

/** What to say about a step that did not succeed, in the words it left. */
function whyItEnded(procId: string | null, code: number | null): string {
  if (code !== null) return 'exited with code ' + code
  const said = procId ? sup.tail(procId, 1) : ''
  return said ? 'did not start — ' + said : 'did not start'
}

function failure(done: string[], step: string, why: string): string {
  const before = done.length ? done.join(', ') + ' ran, then ' : ''
  return before + step + ' failed — ' + why
}

function getWorkspaceOf(id: string): Workspace | null {
  try {
    return requireWorkspace(id)
  } catch {
    return null
  }
}
