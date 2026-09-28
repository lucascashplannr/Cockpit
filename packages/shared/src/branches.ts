import type { ProjectSettings } from './model.js'

/**
 * Does `branch` match one of the protected patterns? `*` is the only wildcard,
 * which covers `release/*` and stops short of asking anyone to write a regex
 * into a settings field.
 *
 * Shared rather than kept in the core: the window draws the shield from the
 * same answer the core refuses on, and two copies of a matcher are two
 * opinions about which branch is protected.
 */
export function matchesBranch(branch: string | null, patterns: readonly string[]): boolean {
  if (!branch) return false
  return patterns.some((raw) => {
    const pattern = raw.trim()
    if (!pattern) return false
    if (!pattern.includes('*')) return pattern === branch
    const rx = new RegExp(
      '^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    )
    return rx.test(branch)
  })
}

/** The patterns one repository of a project protects. Empty unless set. */
export function protectedPatterns(settings: ProjectSettings | null | undefined, repoName: string): string[] {
  // `?.` on the map too: a service started by an older build sends settings
  // without it until it is restarted, and the window must not fall over on that.
  return settings?.protectedBranches?.[repoName] ?? []
}
