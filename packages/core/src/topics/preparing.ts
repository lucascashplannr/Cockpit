import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TopicPreparation } from '@cockpit/shared'

/**
 * §7 — where a topic's `worktrees.setup` stands, apart from the code that runs
 * it so the registry can read it without importing the runner.
 *
 * Running is held in memory: it is only true while this core is alive to see
 * it end. A failure is also written beside the topic's memory, because "your
 * `composer install` failed" must still be on the bar after a restart — the
 * topic has not become bootable just because the process that said so is gone.
 */

const live = new Map<string, TopicPreparation>()
const listeners: (() => void)[] = []

function fileOf(rootPath: string): string {
  return join(rootPath, '.cockpit', 'setup.json')
}

export function onChange(fn: () => void): void {
  listeners.push(fn)
}

export function get(topicId: string, rootPath: string | null): TopicPreparation | null {
  const held = live.get(topicId)
  if (held) return held
  if (!rootPath) return null
  const file = fileOf(rootPath)
  if (!existsSync(file)) return null
  try {
    const read = JSON.parse(readFileSync(file, 'utf8')) as TopicPreparation
    if (read.state !== 'failed' || !Array.isArray(read.steps)) return null
    live.set(topicId, read)
    return read
  } catch {
    return null
  }
}

export function set(topicId: string, rootPath: string | null, p: TopicPreparation | null): void {
  if (p) live.set(topicId, p)
  else live.delete(topicId)
  if (rootPath) {
    const file = fileOf(rootPath)
    try {
      if (p?.state === 'failed') {
        mkdirSync(join(rootPath, '.cockpit'), { recursive: true })
        writeFileSync(file, JSON.stringify(p, null, 2), 'utf8')
      } else if (existsSync(file)) {
        rmSync(file)
      }
    } catch {
      // The bar still says it; only a restart would forget.
    }
  }
  for (const fn of listeners) fn()
}
