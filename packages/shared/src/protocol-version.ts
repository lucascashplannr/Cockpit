/**
 * Handshake between interface and core (§13, "poignée de main de version").
 * MAJOR must match exactly: a mismatch means the UI refuses to talk to the
 * core rather than mis-decoding it. MINOR may differ (additive changes only).
 */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const

export function protocolCompatible(a: { major: number }, b: { major: number }): boolean {
  return a.major === b.major
}
