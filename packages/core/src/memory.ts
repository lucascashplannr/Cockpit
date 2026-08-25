import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionFile, MemoryDoc } from '@cockpit/shared'
import { requireWorkspace } from './registry.js'
import { append } from './journal.js'

/**
 * §6 — three distinct layers, and conflating them is the mistake to avoid:
 *   memory.md    durable, hand-editable, read by agents
 *   journal      automatic, append-only (lives in SQLite, see journal.ts)
 *   sessions/    disposable, listable, comparable
 *
 * The point of the separation: clearing a session becomes free.
 * §15 — memory is versioned, so a colleague can pick up a feature and
 * understand the decisions already made.
 */

export const SECTIONS = ['Objectif', 'Décisions', 'Contraintes', 'Écarté', 'État'] as const

const TEMPLATE = [
  '## Objectif',
  '',
  '## Décisions',
  '_(ce qui a été tranché, et pourquoi)_',
  '',
  '## Contraintes',
  '_(ce qu\'il ne faut pas casser)_',
  '',
  '## Écarté',
  '_(la section la plus précieuse : sans elle, chaque session fraîche',
  'repropose la solution déjà rejetée pour une bonne raison)_',
  '',
  '## État',
  '',
].join('\n')

function cockpitDir(wsPath: string): string {
  return join(wsPath, '.cockpit')
}

export function memoryPath(wsPath: string): string {
  return join(cockpitDir(wsPath), 'memory.md')
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

export function read(workspaceId: string): MemoryDoc | null {
  const ws = requireWorkspace(workspaceId)
  const p = memoryPath(ws.path)
  if (!existsSync(p)) return null
  const content = readFileSync(p, 'utf8')
  return {
    path: p,
    content,
    sections: parseSections(content),
    updatedAt: statSync(p).mtimeMs,
  }
}

export function ensure(workspaceId: string): MemoryDoc {
  const ws = requireWorkspace(workspaceId)
  const p = memoryPath(ws.path)
  if (!existsSync(p)) {
    mkdirSync(cockpitDir(ws.path), { recursive: true })
    writeFileSync(p, TEMPLATE, 'utf8')
    append({ type: 'memory.written', workspaceId, payload: { path: p, created: true } })
  }
  return read(workspaceId)!
}

export function write(workspaceId: string, content: string): void {
  const ws = requireWorkspace(workspaceId)
  mkdirSync(cockpitDir(ws.path), { recursive: true })
  writeFileSync(memoryPath(ws.path), content, 'utf8')
  ws.hasMemory = true
  append({ type: 'memory.written', workspaceId, payload: { bytes: content.length } })
}

/**
 * §6 — "Promotion." Selecting a passage in a session and pushing it into the
 * memory. If writing the memory is a separate effort, it never gets written.
 */
export function promote(workspaceId: string, section: string, text: string): void {
  const doc = ensure(workspaceId)
  const lines = doc.content.split('\n')
  const idx = lines.findIndex((l) => new RegExp('^##\\s+' + escapeRe(section) + '\\s*$').test(l))

  const entry = '- ' + text.trim().replace(/\n+/g, ' ')
  if (idx === -1) {
    lines.push('', '## ' + section, '', entry)
  } else {
    let insertAt = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!)) {
        insertAt = i
        break
      }
    }
    while (insertAt > idx + 1 && !lines[insertAt - 1]!.trim()) insertAt--
    lines.splice(insertAt, 0, entry)
  }

  write(workspaceId, lines.join('\n'))
  append({ type: 'memory.promoted', workspaceId, payload: { section, text: text.slice(0, 500) } })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** §6 — sessions are disposable, listable, comparable. */
export function sessions(workspaceId: string): AgentSessionFile[] {
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
