const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastTs = 0
let counter = 0

/** Sortable, collision-resistant, no dependency. */
export function newId(prefix = ''): string {
  const now = Date.now()
  if (now === lastTs) counter++
  else {
    lastTs = now
    counter = 0
  }
  let ts = now
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ts % 32]! + out
    ts = Math.floor(ts / 32)
  }
  let rand = ''
  for (let i = 0; i < 8; i++) rand += ALPHABET[Math.floor(Math.random() * 32)]!
  const c = counter.toString(32).toUpperCase().padStart(2, '0')
  return prefix + out + c + rand
}

/** Stable id derived from a path, so restarts do not renumber the UI. */
export function stableId(prefix: string, ...parts: string[]): string {
  const s = parts.join(' ')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  const hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  return prefix + '_' + hex
}
