/**
 * Handshake between interface and core (§13, "poignée de main de version").
 * MAJOR must match exactly: a mismatch means the UI refuses to talk to the
 * core rather than mis-decoding it. MINOR may differ (additive changes only).
 */
export const PROTOCOL_VERSION = { major: 1, minor: 8 } as const

export function protocolCompatible(a: { major: number }, b: { major: number }): boolean {
  return a.major === b.major
}

/**
 * A core older than the window is compatible but incomplete: every method
 * added since its build answers `unknown_method`, which surfaces as a bare
 * method name in a toast and looks like a bug in the feature rather than a
 * daemon nobody restarted. Bump MINOR whenever an RPC method is added, so this
 * says so out loud.
 */
export function coreIsBehind(core: { major: number; minor: number }, ui: { major: number; minor: number }): boolean {
  return core.major === ui.major && core.minor < ui.minor
}
