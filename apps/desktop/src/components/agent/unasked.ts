import type { PermissionMode } from '@cockpit/shared'

const NAMES: Partial<Record<PermissionMode, string>> = {
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass',
}

/**
 * The hover text of the mark on a call that ran without being asked about.
 * `mode` is null for a group whose calls ran under more than one.
 */
export function unaskedTitle(mode: PermissionMode | null, count = 1): string {
  const what = count === 1 ? 'Ran without asking' : count + ' ran without asking'
  const why = mode ? ' in ' + (NAMES[mode] ?? mode) : ''
  return what + why + ' — Manual would have asked' + (count === 1 ? '.' : ' about each.')
}
