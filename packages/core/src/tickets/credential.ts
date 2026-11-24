import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COCKPIT_HOME, loadConfig, updateConfig } from '../config.js'
import { run } from '../exec.js'

/**
 * §15 — the way into a tracker, kept on this machine and nowhere else.
 *
 * Who you are (the email) is in config.json, beside the other machine
 * settings. The token is in the macOS keychain, as git's own credentials
 * usually are. It is handed to `security` on stdin (`security -i`), never as
 * an argument, so it is not in `ps` while the write runs. That is the same
 * care the database password gets in `topics.openPlan`.
 *
 * Off macOS there is no `security`, and the token goes in a file only this
 * user can read, under the Cockpit folder.
 */

const SERVICE = 'Cockpit Jira'

export interface TrackerCredential {
  email: string
  token: string
}

export function emailFor(site: string): string | null {
  return loadConfig().trackers?.[site]?.email ?? null
}

export async function read(site: string): Promise<TrackerCredential | null> {
  const email = emailFor(site)
  if (!email) return null
  const token = process.platform === 'darwin' ? await keychainRead(site) : fileRead(site)
  return token ? { email, token } : null
}

export async function save(site: string, cred: TrackerCredential): Promise<void> {
  if (process.platform === 'darwin') await keychainWrite(site, cred.token)
  else fileWrite(site, cred.token)
  updateConfig((c) => {
    c.trackers = { ...(c.trackers ?? {}), [site]: { email: cred.email } }
  })
}

export async function forget(site: string): Promise<void> {
  if (process.platform === 'darwin') {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', site], { timeoutMs: 10_000 })
  } else {
    rmSync(filePath(site), { force: true })
  }
  updateConfig((c) => {
    if (!c.trackers?.[site]) return
    const { [site]: _gone, ...rest } = c.trackers
    c.trackers = rest
  })
}

async function keychainRead(site: string): Promise<string | null> {
  const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', site, '-w'], { timeoutMs: 10_000 })
  const token = r.stdout.trim()
  return r.ok && token ? token : null
}

async function keychainWrite(site: string, token: string): Promise<void> {
  // `-U` replaces the entry a reconnect finds there instead of failing on it.
  const line = 'add-generic-password -U -s ' + quote(SERVICE) + ' -a ' + quote(site) + ' -w ' + quote(token) + '\n'
  const r = await run('security', ['-i'], { input: line, timeoutMs: 15_000 })
  // `security -i` exits 0 even when the command inside it failed; it says so on stderr.
  if (!r.ok || /error|could not/i.test(r.stderr)) {
    throw new Error('The keychain refused the token: ' + (r.stderr.trim() || 'exit ' + r.code))
  }
}

/** For `security -i`'s own parser: double quotes, with `"` and `\` escaped. */
function quote(s: string): string {
  return '"' + s.replace(/(["\\])/g, '\\$1') + '"'
}

function filePath(site: string): string {
  return join(COCKPIT_HOME, 'secrets', 'jira-' + site.replace(/[^a-z0-9.-]/gi, '_'))
}

function fileRead(site: string): string | null {
  const p = filePath(site)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null
}

function fileWrite(site: string, token: string): void {
  const dir = join(COCKPIT_HOME, 'secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(filePath(site), token, { mode: 0o600 })
  chmodSync(filePath(site), 0o600)
}
