import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SkillInfo, SkillWhere, Workspace } from '@cockpit/shared'
import { getWorkspace } from './registry.js'

/**
 * §6 — skills as files: where the engine finds them, and how one is added.
 *
 * Claude reads a skill from `<dir>/<name>/SKILL.md`, in two places this module
 * writes to: the person's own `~/.claude/skills` (every project, and Claude
 * Code outside Cockpit too) and a repository's `.claude/skills` (that project,
 * shared with whoever clones it). Nothing of Cockpit's own: a skill added here
 * is a skill anywhere Claude runs.
 *
 * What makes a skill *usable* is its front matter. The model sees only the
 * name and the description until it decides to open one, so a skill with no
 * description is a skill nothing ever reaches for — refused here rather than
 * written and silently ignored.
 */

export const USER_SKILLS = join(homedir(), '.claude', 'skills')
const REPO_SKILLS = join('.claude', 'skills')

/** The engine's own rule for a skill's name: lowercase, digits and hyphens. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const DESCRIPTION_MAX = 1024

/** The `---` block at the top of a SKILL.md, read loosely. */
export function frontmatterOf(text: string): { name?: string; description?: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  try {
    const y = parseYaml(m[1]!) as Record<string, unknown> | null
    if (!y || typeof y !== 'object') return null
    return {
      name: typeof y.name === 'string' ? y.name.trim() : undefined,
      description: typeof y.description === 'string' ? y.description.trim() : undefined,
    }
  } catch {
    return null
  }
}

function scan(dir: string, where: SkillWhere['kind'], ws?: Workspace): SkillInfo[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const entry of names) {
    const file = join(dir, entry, 'SKILL.md')
    if (!existsSync(file)) continue
    const fm = frontmatterOf(readFileSync(file, 'utf8'))
    out.push({
      name: fm?.name || entry,
      description: fm?.description ?? '',
      where,
      workspaceId: ws?.id,
      repo: ws ? ws.repoName || ws.name : undefined,
      path: join(dir, entry),
    })
  }
  return out
}

/** The skills on disk for these checkouts: the person's own, then each repository's. */
export function list(workspaceIds: string[]): SkillInfo[] {
  const out = scan(USER_SKILLS, 'user')
  for (const id of workspaceIds) {
    const ws = getWorkspace(id)
    if (ws) out.push(...scan(join(ws.path, REPO_SKILLS), 'repo', ws))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Why a name or a description would not work, or null when both would. */
export function problemWith(name: string, description: string): string | null {
  if (!NAME.test(name)) return 'A skill’s name is lowercase letters, digits and hyphens — at most 64'
  if (!description.trim()) return 'Say when to use it: Claude only reads the description to decide'
  if (description.length > DESCRIPTION_MAX) return 'The description is at most ' + DESCRIPTION_MAX + ' characters'
  return null
}

function dirFor(where: SkillWhere): string {
  if (where.kind === 'user') return USER_SKILLS
  const ws = getWorkspace(where.workspaceId)
  if (!ws) throw new Error('unknown repository: ' + where.workspaceId)
  return join(ws.path, REPO_SKILLS)
}

/** A new skill, written the way the engine reads one. */
export function create(input: { name: string; description: string; body: string; where: SkillWhere }): SkillInfo {
  const name = input.name.trim()
  const description = input.description.replace(/\s+/g, ' ').trim()
  const problem = problemWith(name, description)
  if (problem) throw new Error(problem)
  const dir = join(dirFor(input.where), name)
  if (existsSync(dir)) throw new Error('There is already a skill called “' + name + '” there')
  mkdirSync(dir, { recursive: true })
  const head = stringifyYaml({ name, description }, { lineWidth: 0 }).trimEnd()
  const body = input.body.trim() || '# ' + name + '\n\nWhat to do, step by step.'
  writeFileSync(join(dir, 'SKILL.md'), '---\n' + head + '\n---\n\n' + body + '\n', 'utf8')
  const ws = input.where.kind === 'repo' ? getWorkspace(input.where.workspaceId) ?? undefined : undefined
  return { name, description, where: input.where.kind, workspaceId: ws?.id, repo: ws ? ws.repoName || ws.name : undefined, path: dir }
}

/**
 * Skills copied in from a folder: one skill (it holds a SKILL.md) or a folder
 * of them (its subfolders do). Each is checked like a new one — a copy that
 * Claude would never pick is not imported — and nothing already there is
 * overwritten.
 */
export function importFrom(input: { from: string; where: SkillWhere }): {
  imported: string[]
  skipped: { name: string; reason: string }[]
} {
  const from = input.from
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error('Not a folder: ' + from)
  const sources = existsSync(join(from, 'SKILL.md'))
    ? [from]
    : readdirSync(from)
        .map((e) => join(from, e))
        .filter((d) => existsSync(join(d, 'SKILL.md')))
  if (!sources.length) throw new Error('No SKILL.md there, nor in the folders inside it')
  const target = dirFor(input.where)
  const imported: string[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const src of sources) {
    const fm = frontmatterOf(readFileSync(join(src, 'SKILL.md'), 'utf8'))
    const name = fm?.name || basename(src)
    const problem = !fm ? 'its SKILL.md has no front matter (name, description)' : problemWith(name, fm.description ?? '')
    if (problem) {
      skipped.push({ name, reason: problem })
      continue
    }
    const dest = join(target, name)
    if (existsSync(dest)) {
      skipped.push({ name, reason: 'already there' })
      continue
    }
    mkdirSync(target, { recursive: true })
    cpSync(src, dest, { recursive: true })
    imported.push(name)
  }
  return { imported, skipped }
}
