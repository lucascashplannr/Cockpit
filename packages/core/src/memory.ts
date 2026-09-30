import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MEMORY_SECTIONS, RULED_OUT_SECTION, STATE_SECTION, canonicalSection, englishMemory, hasMemoryEntries,
  memoryTemplate,
} from '@cockpit/shared'
import type { Actor, Conversation, TranscriptFile, MemoryDoc } from '@cockpit/shared'
import { getProject, getTopic, getWorkspace, memoryFileOf, requireWorkspace, topicMemoryFile } from './registry.js'
import { append } from './journal.js'

/**
 * §6 — three distinct layers, and conflating them is the mistake to avoid:
 *   memory.md    durable, hand-editable, read by agents
 *   journal      automatic, append-only (lives in SQLite, see journal.ts)
 *   sessions/    disposable, listable, comparable
 *
 * The point of the separation: clearing a session becomes free.
 * §15 — memory is versioned, so a colleague can pick up a topic and
 * understand the decisions already made.
 */

export const SECTIONS = MEMORY_SECTIONS

function cockpitDir(wsPath: string): string {
  return join(wsPath, '.cockpit')
}

/**
 * §6 is titled "la mémoire **de topic**", and that is the whole point: the
 * understanding belongs to the work, not to one of the checkouts the work
 * happens to span. So a workspace inside a topic reads and writes the
 * topic's memory — the same file the preamble prepends to every run. Outside
 * a topic it is the project's (§21.2): see `memoryFileOf`, which the probe's
 * `hasMemory` reads too.
 */
function memoryFile(workspaceId: string): string {
  return memoryFileOf(requireWorkspace(workspaceId))
}

/**
 * The memory a conversation shares, and what it is the memory *of*.
 *
 * The same resolution as a checkout's, from the conversation's side: its
 * topic if it has one, otherwise the project its first checkout belongs to.
 */
export interface MemoryHome {
  file: string
  /** What the preamble calls it: the topic's name, or the project's. */
  label: string
  kind: 'topic' | 'project'
  /** The checkout whose id the journal files the writes under. */
  workspaceId: string | null
}

export function homeOf(c: Pick<Conversation, 'topicId' | 'workspaceIds'>): MemoryHome | null {
  const ws = c.workspaceIds.map((id) => getWorkspace(id)).find((w) => !!w) ?? null
  const topic = c.topicId ? getTopic(c.topicId) : null
  if (topic) return { file: topicMemoryFile(topic), label: topic.name, kind: 'topic', workspaceId: ws?.id ?? null }
  const project = ws ? getProject(ws.projectId) : null
  if (!project) return null
  return {
    file: join(project.root, '.cockpit', 'memory.md'),
    label: project.name,
    kind: 'project',
    workspaceId: ws?.id ?? null,
  }
}

/**
 * The memory as the engine reads it, at the opening of a conversation's first
 * turn — and again on a relaunch, because the memory has moved on since and
 * the conversation has not (see `agent.resume`).
 */
export function preamble(home: MemoryHome | null): string {
  if (!home) return ''
  const content = contentAt(home.file)?.trim()
  if (!content || !hasMemoryEntries(content)) return ''
  return [
    '# ' + (home.kind === 'topic' ? 'Topic' : 'Project') + ' memory — ' + home.label,
    'Shared by every conversation on this ' + home.kind + ', in every repository, and by the one',
    'that picks up after this one is cleared. "' + RULED_OUT_SECTION + '" lists approaches already',
    'rejected for a reason: do not re-propose them. "Contracts" is what other code relies on.',
    '',
    content,
  ].join('\n')
}

/**
 * The file as it stands, or null — for the preamble and the live update.
 * Always in English: a memory written by an earlier build under the French
 * headings reads as if it had been written today.
 */
export function contentAt(file: string): string | null {
  try {
    return existsSync(file) ? englishMemory(readFileSync(file, 'utf8')) : null
  } catch {
    return null
  }
}

export function sessionsDir(wsPath: string): string {
  return join(cockpitDir(wsPath), 'sessions')
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
 * The memory, as the Memory tool shows it. Never "no memory": a topic or a
 * project that has nothing written yet has the empty form, which is also what
 * says where things go. The file itself is only written when something is.
 */
export function read(workspaceId: string): MemoryDoc {
  const p = memoryFile(workspaceId)
  const content = contentAt(p) ?? memoryTemplate(titleFor(workspaceId))
  return {
    path: p,
    content,
    sections: parseSections(content),
    updatedAt: existsSync(p) ? statSync(p).mtimeMs : null,
  }
}

/** A topic's memory opens with its name; the project's needs none. */
function titleFor(workspaceId: string): string | undefined {
  const ws = requireWorkspace(workspaceId)
  return ws.topicId ? (getTopic(ws.topicId)?.name ?? undefined) : undefined
}

export function write(workspaceId: string, content: string): void {
  const ws = requireWorkspace(workspaceId)
  const p = memoryFile(workspaceId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
  ws.hasMemory = hasMemoryEntries(content)
  append({ type: 'memory.written', workspaceId, payload: { bytes: content.length } })
}

/**
 * §6 — "Promotion." Selecting a passage in a session and pushing it into the
 * memory. If writing the memory is a separate effort, it never gets written.
 */
export function promote(workspaceId: string, section: string, text: string): void {
  const doc = read(workspaceId)
  write(workspaceId, withEntry(doc.content, canonicalSection(section), '- ' + oneLine(text)))
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
export function note(home: MemoryHome, section: string, text: string, by: string, actor: Actor): string {
  const content = ensureAt(home)
  const entry = '- ' + unsigned(oneLine(text)) + ' _(' + by + ', ' + shortDate() + ')_'
  writeAt(home, withEntry(content, canonicalSection(section), entry))
  append({
    type: 'memory.promoted',
    actor,
    workspaceId: home.workspaceId,
    payload: { section: canonicalSection(section), text: text.slice(0, 500), by },
  })
  return entry
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
  return contentAt(home.file) ?? memoryTemplate(home.kind === 'topic' ? home.label : undefined)
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

/** §6 — sessions are disposable, listable, comparable. */
export function sessions(workspaceId: string): TranscriptFile[] {
  const ws = requireWorkspace(workspaceId)
  const dir = sessionsDir(ws.path)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.md'))
    .map((f) => {
      const st = statSync(join(dir, f))
      return {
        id: f.replace(/\.(jsonl|md)$/, ''),
        path: join(dir, f),
        startedAt: st.birthtimeMs || st.mtimeMs,
        engine: f.split('-')[0] ?? 'unknown',
        bytes: st.size,
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
}
