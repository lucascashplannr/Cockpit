import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MEMORY_NEW, MEMORY_OFF, MEMORY_SECTIONS, PROJECT_MEMORY, RULED_OUT_SECTION, STATE_SECTION, canonicalSection,
  englishMemory, hasMemoryEntries, memoryTemplate, shapedMemory, slugify, topicMemoryId,
} from '@cockpit/shared'
import type { MemoryKind } from '@cockpit/shared'
import type { Actor, Conversation, MemoryDoc, MemorySummary } from '@cockpit/shared'
import { allTopics, getProject, getTopic, getWorkspace, requireWorkspace, topicMemoryFile } from './registry.js'
import { append } from './journal.js'
import { moveToTrash } from './files.js'

/**
 * §6 — three distinct layers, and conflating them is the mistake to avoid:
 *   memory.md       durable, hand-editable, read by agents
 *   journal         automatic, append-only (lives in SQLite, see journal.ts)
 *   conversations   disposable, resumable (agent_sessions in SQLite, agents.ts)
 *
 * The point of the separation: clearing a session becomes free.
 * §15 — memory is versioned, so a colleague can pick up a topic and
 * understand the decisions already made.
 */

export const SECTIONS = MEMORY_SECTIONS

/**
 * §6 — where the memories live, and which one a conversation uses.
 *
 * A project has as many memories as the work in it: one per piece of work,
 * named after the conversation that started writing it, kept until a person
 * erases it or it empties into the docs. A conversation is pointed at one of
 * them when it starts — a new one, an existing one, or none — and a `/clear`
 * hands the next conversation the same one. A topic keeps its own, as ever.
 *
 * Ids, as stored on the conversation:
 *   `topic:<id>`  the topic's memory (registry.topicMemoryFile)
 *   `project`     the project's single memory from before there were several
 *   anything else a named memory: `<project>/.cockpit/memories/<id>.md`
 *   `new` / `off` no file — yet, or at all
 */
export interface MemoryHome {
  id: string
  file: string
  /** Its name: the topic's, the project's, or the one it was given. */
  label: string
  kind: MemoryKind
  /** The checkout whose id the journal files the writes under. */
  workspaceId: string | null
}

function memoriesDir(projectRoot: string): string {
  return join(projectRoot, '.cockpit', 'memories')
}

export function homeFor(projectId: string, memoryId: string, workspaceId: string | null = null): MemoryHome | null {
  if (memoryId === MEMORY_OFF || memoryId === MEMORY_NEW) return null
  const project = getProject(projectId)
  if (memoryId.startsWith('topic:')) {
    const topic = getTopic(memoryId.slice(6))
    if (!topic) return null
    return { id: memoryId, file: topicMemoryFile(topic), label: topic.name, kind: 'topic', workspaceId }
  }
  if (!project) return null
  if (memoryId === PROJECT_MEMORY) {
    return { id: memoryId, file: join(project.root, '.cockpit', 'memory.md'), label: project.name, kind: 'project', workspaceId }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(memoryId)) return null
  const file = join(memoriesDir(project.root), memoryId + '.md')
  return { id: memoryId, file, label: nameIn(file) ?? memoryId, kind: 'named', workspaceId }
}

/** A conversation's memory, or null when it has none — off, or not yet written. */
export function homeOf(c: Pick<Conversation, 'memory' | 'workspaceIds'>): MemoryHome | null {
  const ws = c.workspaceIds.map((id) => getWorkspace(id)).find((w) => !!w) ?? null
  if (!ws) return null
  return homeFor(ws.projectId, c.memory, ws.id)
}

/** The first `# ` line: a named memory is called what its file says. */
function nameIn(file: string): string | null {
  try {
    const first = readFileSync(file, 'utf8').split('\n').find((l) => /^#\s+/.test(l))
    return first ? first.replace(/^#\s+/, '').trim() || null : null
  } catch {
    return null
  }
}

/**
 * A new memory, named after the work it is for — the conversation's title —
 * and created the moment something is first written into it: until then there
 * is nothing to keep.
 */
export function createNamed(projectId: string, name: string): string {
  const project = getProject(projectId)
  if (!project) throw new Error('unknown project: ' + projectId)
  const dir = memoriesDir(project.root)
  mkdirSync(dir, { recursive: true })
  const base = slugify(name).slice(0, 48).replace(/-+$/, '') || 'memory'
  let id = base
  for (let n = 2; existsSync(join(dir, id + '.md')); n++) id = base + '-' + n
  writeFileSync(join(dir, id + '.md'), memoryTemplate('named', name.trim().slice(0, 80) || id), 'utf8')
  append({ type: 'memory.written', projectId, payload: { created: id, name } })
  return id
}

/**
 * A named memory's heading swapped, only while it still reads `from` — the
 * name it was given when it had nothing better. A name a person typed stays.
 */
export function retitle(projectId: string, memoryId: string, from: string, to: string): void {
  const home = homeFor(projectId, memoryId)
  if (!home || home.kind !== 'named' || !existsSync(home.file)) return
  const was = from.trim().slice(0, 80)
  const content = readFileSync(home.file, 'utf8')
  const lines = content.split('\n')
  const i = lines.findIndex((l) => /^#\s+/.test(l))
  if (i === -1 || lines[i]!.replace(/^#\s+/, '').trim() !== was) return
  lines[i] = '# ' + to.trim()
  writeFileSync(home.file, lines.join('\n'), 'utf8')
  append({ type: 'memory.written', projectId, payload: { renamed: memoryId, name: to } })
}

/**
 * Every memory a conversation in this project can be pointed at, most recently
 * written first: the named ones, the project's old single one while it has
 * anything in it, and the topics' — a topic's memory is where its work was
 * written down, and continuing it from the main checkout is ordinary.
 */
export function list(projectId: string): MemorySummary[] {
  const project = getProject(projectId)
  if (!project) return []
  const out: MemorySummary[] = []
  const add = (home: MemoryHome | null) => {
    if (!home || !existsSync(home.file)) return
    const content = contentAt(home.file, home.kind) ?? ''
    const entries = content.split('\n').filter((l) => /^\s*[-*+]\s+/.test(l)).length
    if (home.kind !== 'named' && !entries) return
    out.push({ id: home.id, name: home.label, kind: home.kind, entries, updatedAt: statSync(home.file).mtimeMs })
  }
  try {
    for (const f of readdirSync(memoriesDir(project.root))) {
      if (f.endsWith('.md')) add(homeFor(projectId, f.slice(0, -3)))
    }
  } catch {
    /* no named memory yet */
  }
  add(homeFor(projectId, PROJECT_MEMORY))
  for (const t of allTopics(projectId)) add(homeFor(projectId, topicMemoryId(t.id)))
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The memory as the engine reads it, at the opening of a conversation's first
 * turn — and again on a relaunch, because the memory has moved on since and
 * the conversation has not (see `agent.resume`).
 */
export function preamble(home: MemoryHome | null): string {
  if (!home) return ''
  const content = contentAt(home.file, home.kind)?.trim()
  if (!content || !hasMemoryEntries(content)) return ''
  return [
    '# Memory — ' + home.label,
    'Shared with every conversation pointed at this memory, in any repository, and with the one that',
    'picks up after this one is cleared. "' + RULED_OUT_SECTION + '" lists approaches already rejected',
    'for a reason: do not re-propose them. "Contracts" is what other code relies on. "Open questions"',
    'are waiting on the person: ask them rather than guessing.',
    '',
    content,
  ].join('\n')
}

/** Anything written beyond the template — the shared test, under the core's name. */
export const hasEntries = hasMemoryEntries

/**
 * The file as it stands, or null — for the preamble and the live update.
 * Always in the current shape: a memory written by an earlier build, in French
 * or in the old order, reads as if it had been written today. Only headings
 * move; what is under them is untouched. The file itself catches up on the
 * next write.
 */
export function contentAt(file: string, kind: MemoryKind): string | null {
  try {
    return existsSync(file) ? shapedMemory(englishMemory(readFileSync(file, 'utf8')), kind) : null
  } catch {
    return null
  }
}

function parseSections(content: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let current: { title: string; body: string } | null = null
  for (const line of content.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current) out.push(current)
      current = { title: m[1]!, body: '' }
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }
  if (current) out.push(current)
  return out.map((s) => ({ title: s.title, body: s.body.trim() }))
}

/**
 * Which memory a request from the window means: the one it names, or, for a
 * checkout, the one it had before there were several — its topic's, else the
 * project's.
 */
function homeAt(workspaceId: string, memoryId?: string): MemoryHome {
  const ws = requireWorkspace(workspaceId)
  const id = memoryId ?? (ws.topicId ? topicMemoryId(ws.topicId) : PROJECT_MEMORY)
  const home = homeFor(ws.projectId, id, ws.id)
  if (!home) throw new Error('no such memory: ' + id)
  return home
}

/**
 * The memory, as the Memory tool shows it. Never blank: one with nothing
 * written yet shows the empty form, which is also what says where things go.
 * The file itself is only written when something is.
 */
export function read(workspaceId: string, memoryId?: string): MemoryDoc {
  const home = homeAt(workspaceId, memoryId)
  const content =
    contentAt(home.file, home.kind) ?? memoryTemplate(home.kind, home.kind === 'project' ? undefined : home.label)
  return {
    id: home.id,
    name: home.label,
    kind: home.kind,
    path: home.file,
    content,
    sections: parseSections(content),
    updatedAt: existsSync(home.file) ? statSync(home.file).mtimeMs : null,
  }
}

/**
 * Erased by hand: to the Trash — recoverable from there, like everything else
 * Cockpit removes (§16). A topic's is re-created empty at once, so every topic
 * keeps a memory; a named one is simply gone, and a conversation still pointed
 * at it starts it again with its next note.
 */
export async function erase(workspaceId: string, memoryId?: string): Promise<{ ok: true; erased: boolean }> {
  const home = homeAt(workspaceId, memoryId)
  if (!existsSync(home.file)) return { ok: true, erased: false }
  await moveToTrash(home.file)
  if (home.kind === 'topic') writeFileSync(home.file, memoryTemplate('topic', home.label), 'utf8')
  const ws = requireWorkspace(workspaceId)
  if (ws.topicId && home.kind === 'topic') ws.hasMemory = false
  append({ type: 'memory.written', workspaceId, payload: { erased: true, memory: home.id } })
  return { ok: true, erased: true }
}

export function write(workspaceId: string, content: string, memoryId?: string): void {
  const home = homeAt(workspaceId, memoryId)
  mkdirSync(dirname(home.file), { recursive: true })
  writeFileSync(home.file, content, 'utf8')
  append({ type: 'memory.written', workspaceId, payload: { bytes: content.length, memory: home.id } })
}

/**
 * §6 — "Promotion." Selecting a passage in a session and pushing it into the
 * memory. If writing the memory is a separate effort, it never gets written.
 */
export function promote(workspaceId: string, section: string, text: string, memoryId?: string): void {
  const doc = read(workspaceId, memoryId)
  write(workspaceId, withEntry(doc.content, canonicalSection(section), '- ' + oneLine(text)), memoryId)
  append({ type: 'memory.promoted', workspaceId, payload: { section, text: text.slice(0, 500) } })
}

/**
 * An agent's note, as it works. Filed under the section it names, signed with
 * where it came from — "the frontend" is what makes a note about an endpoint
 * readable to the agent on the backend — and journalled as the agent's, so the
 * memory keeps the same human/agent line the diff does (§12).
 *
 * Answers the line it wrote, so the conversation that wrote it can be told
 * apart from the others when their notes are passed on (see `newSince`).
 */
export function note(
  home: MemoryHome,
  section: string,
  text: string,
  by: string,
  actor: Actor,
  /**
   * An entry this one supersedes — an open question now answered, a contract
   * that changed. Matched on its words, signature aside; it goes, this comes.
   * Without it a memory only ever grows, and says two things about one fact.
   */
  replaces?: string,
): { entry: string; replaced: string | null } {
  let content = ensureAt(home)
  let replaced: string | null = null
  if (replaces?.trim()) {
    const r = withoutEntry(content, replaces)
    content = r.content
    replaced = r.removed
  }
  const entry = '- ' + unsigned(oneLine(text)) + ' _(' + by + ', ' + shortDate() + ')_'
  writeAt(home, withEntry(content, canonicalSection(section), entry))
  append({
    type: 'memory.promoted',
    actor,
    workspaceId: home.workspaceId,
    payload: { section: canonicalSection(section), text: text.slice(0, 500), by, ...(replaced ? { replaced } : {}) },
  })
  return { entry, replaced }
}

/**
 * Entries gone from the memory — the Document step's pruning, once a person
 * has accepted it: what the docs now say, the memory no longer has to. Exact
 * lines only; an entry rewritten since the proposal is left where it is.
 */
export function forget(home: MemoryHome, lines: string[], actor: Actor): number {
  const content = contentAt(home.file, home.kind)
  if (!content) return 0
  const drop = new Set(lines)
  const kept = content.split('\n').filter((l) => !drop.has(l))
  const removed = content.split('\n').length - kept.length
  if (!removed) return 0
  writeAt(home, kept.join('\n'))
  append({ type: 'memory.written', actor, workspaceId: home.workspaceId, payload: { forgot: removed } })
  return removed
}

/** The first `- ` entry whose words contain `words`, taken out. */
function withoutEntry(content: string, words: string): { content: string; removed: string | null } {
  const key = (s: string) => unsigned(s.replace(/^\s*[-*+]\s+/, '')).toLowerCase().replace(/\s+/g, ' ').trim()
  const want = key(words)
  const lines = content.split('\n')
  const i = lines.findIndex((l) => /^\s*[-*+]\s+/.test(l) && (key(l) === want || key(l).includes(want)))
  if (i === -1 || !want) return { content, removed: null }
  const [removed] = lines.splice(i, 1)
  return { content: lines.join('\n'), removed: removed ?? null }
}

/**
 * "Où on en est" is the one section that is replaced rather than added to:
 * a state is true once, and a list of every state it has been in is a log —
 * which is the journal's job, and would grow the preamble without end.
 */
export function setState(home: MemoryHome, text: string, by: string, actor: Actor): string[] {
  const content = ensureAt(home)
  const body = unsigned(text.trim()) + '\n\n_(' + by + ', ' + shortDate() + ')_'
  writeAt(home, withSection(content, STATE_SECTION, body))
  append({ type: 'memory.written', actor, workspaceId: home.workspaceId, payload: { section: STATE_SECTION, by } })
  return body.split('\n').filter((l) => l.trim())
}

function ensureAt(home: MemoryHome): string {
  return contentAt(home.file, home.kind) ?? memoryTemplate(home.kind, home.kind === 'topic' ? home.label : undefined)
}

function writeAt(home: MemoryHome, content: string): void {
  mkdirSync(dirname(home.file), { recursive: true })
  writeFileSync(home.file, content, 'utf8')
  const ws = home.workspaceId ? getWorkspace(home.workspaceId) : null
  if (ws) ws.hasMemory = true
}

/**
 * The lines of `now` that were not in `then` and were not written by `own` —
 * what another conversation added since this one last looked. Line-wise on
 * purpose: entries are one line each, and a replaced state shows up as its
 * new lines, which is what the reader needs.
 */
export function newSince(then: string | null, now: string | null, own: Set<string>): string[] {
  if (!now) return []
  const seen = new Set((then ?? '').split('\n'))
  let section = ''
  const out: string[] = []
  for (const line of now.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      section = h[1]!
      continue
    }
    if (!line.trim() || seen.has(line) || own.has(line) || /^_\(.*\)_$/.test(line.trim())) continue
    out.push((section ? '[' + section + '] ' : '') + line.replace(/^-\s+/, ''))
  }
  return out
}

/**
 * The text without a signature of its own. An agent reads signed entries and,
 * reasonably, signs its next one the same way — which is the core's job, and
 * two of them on one line is noise in every preamble after.
 */
function unsigned(text: string): string {
  const sig = /\s*_?\(\s*[^()]{1,60},\s*\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\)_?\s*$/i
  let t = text
  while (sig.test(t)) t = t.replace(sig, '')
  return t.trimEnd()
}

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n+\s*/g, ' ')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "30 Sep" — spelled out by hand: a locale's idea of it ("30 Sept") drifts. */
function shortDate(): string {
  const d = new Date()
  return d.getDate() + ' ' + MONTHS[d.getMonth()]
}

/** `entry` at the end of `section`, which is created at the end if absent. */
function withEntry(content: string, section: string, entry: string): string {
  const lines = content.split('\n')
  const idx = lines.findIndex((l) => new RegExp('^##\\s+' + escapeRe(section) + '\\s*$').test(l))
  if (idx === -1) {
    lines.push('', '## ' + section, '', entry)
    return lines.join('\n')
  }
  let insertAt = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      insertAt = i
      break
    }
  }
  while (insertAt > idx + 1 && !lines[insertAt - 1]!.trim()) insertAt--
  lines.splice(insertAt, 0, entry)
  return lines.join('\n')
}

/** `section`'s body replaced by `body`, the heading kept where it was. */
function withSection(content: string, section: string, body: string): string {
  const lines = content.split('\n')
  const idx = lines.findIndex((l) => new RegExp('^##\\s+' + escapeRe(section) + '\\s*$').test(l))
  if (idx === -1) return content.replace(/\s*$/, '') + '\n\n## ' + section + '\n\n' + body + '\n'
  let end = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i
      break
    }
  }
  const tail = end < lines.length ? [''] : []
  lines.splice(idx + 1, end - idx - 1, '', ...body.split('\n'), ...tail)
  return lines.join('\n').replace(/\s*$/, '') + '\n'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
