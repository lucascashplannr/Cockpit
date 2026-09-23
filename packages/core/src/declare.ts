import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { MANIFEST_FILENAMES } from '@cockpit/shared'
import type { Declaration, DeclarationScope, Declarations } from '@cockpit/shared'
import { findManifest, readManifest } from './detect.js'
import { getProject, allWorkspaces } from './registry.js'
import { append } from './journal.js'

/**
 * §8 — reading and writing `servers:` / `commands:` from the window.
 *
 * The manifest stays the source of truth and stays hand-writable (§11): this
 * edits the same file a person edits, in place, through `parseDocument` so
 * every comment and every unrelated key survives. What it buys is the class of
 * mistake a text field cannot make — a `cmd` holding a comma no longer closes
 * a YAML flow mapping and truncates itself, which is exactly how the first
 * hand-written `wiring` command in this project turned into a syntax error.
 */

/** Where a declaration runs: a repository, or the project's own folder. */
export function scopesOf(projectId: string): DeclarationScope[] {
  const project = getProject(projectId)
  if (!project) return []
  const repos = allWorkspaces(projectId)
    .filter((w) => w.kind === 'main' && w.repoName)
    .map((w) => ({ repo: w.repoName, label: w.repoName, path: w.path }))
  // The project first, because it is the one scope that always exists and the
  // one a "start everything" belongs to.
  return [{ repo: '', label: project.name, path: project.root }, ...repos]
}

export function declarationsOf(projectId: string): Declarations {
  const project = getProject(projectId)
  const path = project ? (project.manifestPath ?? findManifest(project.root)) : null
  const manifest = path ? readManifest(path).manifest : null
  const start = manifest?.start ?? null

  const out: Declaration[] = []
  for (const [name, d] of Object.entries(manifest?.servers ?? {})) {
    out.push({
      kind: 'server',
      name,
      repo: d.repo ? basename(d.repo) : '',
      cmd: d.cmd ?? '',
      url: d.url ?? '',
      health: d.health ?? '',
      env: Object.entries(d.env ?? {}).map(([key, value]) => ({ key, value })),
      ask: [],
      runs: [],
      confirm: '',
      // An absent `start:` means every server, which is the default the file
      // does not have to spell out.
      inStart: !start || start.includes(name),
    })
  }
  for (const [name, d] of Object.entries(manifest?.commands ?? {})) {
    out.push({
      kind: 'command',
      name,
      repo: d.repo ? basename(d.repo) : '',
      cmd: d.cmd ?? '',
      url: '',
      health: '',
      env: [],
      ask: Object.entries(d.ask ?? {}).map(([key, label]) => ({ key, label: String(label) })),
      runs: d.runs ?? [],
      confirm: d.confirm === true ? 'true' : d.confirm ? String(d.confirm) : '',
      inStart: false,
    })
  }
  return { projectId, manifestPath: path, scopes: scopesOf(projectId), declarations: out }
}

/* ── writing ─────────────────────────────────────────────────────────── */

function manifestPathFor(projectId: string): string | null {
  const project = getProject(projectId)
  if (!project) return null
  return project.manifestPath ?? findManifest(project.root) ?? join(project.root, MANIFEST_FILENAMES[0])
}

/** The document as it is on disk, or a new one with the two required keys. */
function open(path: string, projectName: string) {
  if (existsSync(path)) return parseDocument(readFileSync(path, 'utf8'))
  const doc = parseDocument('')
  doc.set('version', 1)
  doc.set('name', projectName)
  return doc
}

/** Only what was filled in: an empty field is an absent key, not an empty one. */
function bodyOf(d: Declaration): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (d.repo) body.repo = d.repo
  if (d.kind === 'command' && d.runs.length) body.runs = d.runs
  if (d.cmd.trim()) body.cmd = d.cmd.trim()
  if (d.kind === 'server') {
    if (d.url.trim()) body.url = d.url.trim()
    if (d.health.trim()) body.health = d.health.trim()
    const env = d.env.filter((e) => e.key.trim())
    if (env.length) body.env = Object.fromEntries(env.map((e) => [e.key.trim(), e.value]))
  } else {
    const ask = d.ask.filter((a) => a.key.trim())
    if (ask.length) body.ask = Object.fromEntries(ask.map((a) => [a.key.trim(), a.label]))
    if (d.confirm.trim()) body.confirm = d.confirm.trim() === 'true' ? true : d.confirm.trim()
  }
  return body
}

export interface SaveResult {
  ok: boolean
  detail: string
  manifestPath: string | null
}

export function saveDeclaration(
  projectId: string,
  decl: Declaration,
  previousName?: string,
): SaveResult {
  const project = getProject(projectId)
  const path = manifestPathFor(projectId)
  if (!project || !path) return { ok: false, detail: 'no project', manifestPath: null }

  const name = decl.name.trim()
  if (!name) return { ok: false, detail: 'a name is required', manifestPath: path }
  if (!decl.cmd.trim() && !decl.runs.length) {
    return { ok: false, detail: 'a command line, or a list to run', manifestPath: path }
  }

  const section = decl.kind === 'server' ? 'servers' : 'commands'
  let doc
  try {
    doc = open(path, project.name)
  } catch (e) {
    return { ok: false, detail: 'could not read the manifest: ' + String(e), manifestPath: path }
  }

  if (!isMap(doc.get(section))) doc.set(section, doc.createNode({}))
  const old = previousName?.trim()
  if (old && old !== name) doc.deleteIn([section, old])
  doc.setIn([section, name], doc.createNode(bodyOf(decl)))

  if (decl.kind === 'server') applyStart(doc, name, old, decl.inStart)
  if (old && old !== name) renameInRuns(doc, old, name)

  try {
    writeFileSync(path, String(doc), 'utf8')
  } catch (e) {
    return { ok: false, detail: 'could not write the manifest: ' + String(e), manifestPath: path }
  }
  append({
    type: 'manifest.written',
    projectId,
    actor: { kind: 'human' },
    payload: { section, name, previousName: old ?? null },
  })
  return { ok: true, detail: name + ' saved', manifestPath: path }
}

export function removeDeclaration(projectId: string, kind: Declaration['kind'], name: string): SaveResult {
  const path = manifestPathFor(projectId)
  if (!path || !existsSync(path)) return { ok: false, detail: 'no manifest', manifestPath: path }
  const section = kind === 'server' ? 'servers' : 'commands'
  let doc
  try {
    doc = parseDocument(readFileSync(path, 'utf8'))
  } catch (e) {
    return { ok: false, detail: 'could not read the manifest: ' + String(e), manifestPath: path }
  }
  doc.deleteIn([section, name])
  // An emptied section is removed rather than left as `servers: {}`, which is
  // a line that says nothing and that nobody would have written by hand.
  const left = doc.get(section)
  if (isMap(left) && left.items.length === 0) doc.delete(section)
  if (kind === 'server') applyStart(doc, name, name, true)
  removeFromRuns(doc, name)

  try {
    writeFileSync(path, String(doc), 'utf8')
  } catch (e) {
    return { ok: false, detail: 'could not write the manifest: ' + String(e), manifestPath: path }
  }
  append({
    type: 'manifest.written',
    projectId,
    actor: { kind: 'human' },
    payload: { section, name, removed: true },
  })
  return { ok: true, detail: name + ' removed', manifestPath: path }
}

/**
 * `start:` is written only when it says something.
 *
 * Absent means "every server", so a project where all of them start keeps a
 * file with no `start:` line in it at all — and one that lists every server is
 * collapsed back to that. The list exists to express an exception.
 */
function applyStart(doc: ReturnType<typeof parseDocument>, name: string, previous: string | undefined, wanted: boolean): void {
  const servers = doc.get('servers')
  const every = isMap(servers) ? servers.items.map((i) => String(i.key)) : []
  const node = doc.get('start')
  let list = isSeq(node) ? node.items.map((i) => String(isMap(i) ? '' : (i as { value?: unknown }).value ?? i)) : null

  if (list && previous && previous !== name) list = list.map((n) => (n === previous ? name : n))
  if (!list) list = [...every]

  list = list.filter((n) => every.includes(n) && n !== name)
  if (wanted && every.includes(name)) list = every.filter((n) => n === name || list!.includes(n))

  if (list.length === every.length) doc.delete('start')
  else doc.set('start', doc.createNode(list))
}

function eachRuns(doc: ReturnType<typeof parseDocument>, fn: (names: string[]) => string[]): void {
  const commands = doc.get('commands')
  if (!isMap(commands)) return
  for (const item of commands.items) {
    const key = String(item.key)
    const runs = doc.getIn(['commands', key, 'runs'])
    if (!isSeq(runs)) continue
    const names = runs.items.map((i) => String((i as { value?: unknown }).value ?? i))
    const next = fn(names)
    if (next.length) doc.setIn(['commands', key, 'runs'], doc.createNode(next))
    else doc.deleteIn(['commands', key, 'runs'])
  }
}

/** A rename must not silently break the list that referred to the old name. */
function renameInRuns(doc: ReturnType<typeof parseDocument>, from: string, to: string): void {
  eachRuns(doc, (names) => names.map((n) => (n === from ? to : n)))
}

function removeFromRuns(doc: ReturnType<typeof parseDocument>, name: string): void {
  eachRuns(doc, (names) => names.filter((n) => n !== name))
}
