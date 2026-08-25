import { DEFAULT_PORT, loadConfig } from './config.js'
import { getDb, pruneJournal, schemaOutcome } from './db.js'
import { append } from './journal.js'
import * as registry from './registry.js'
import * as supervisor from './supervisor.js'
import * as agents from './agents.js'
import * as leases from './leases.js'
import * as terminals from './terminals.js'
import * as watcher from './watcher.js'
import { pushWorkspaces, startServer } from './server.js'

/**
 * §13 — the core is a permanent service. It starts at login, restarts on
 * crash, and dev servers and agents survive the window being closed.
 * §13 rule 3 — it does not trust its own database at boot: it probes and
 * resynchronises. It persists the journal, not the state.
 */

async function main(): Promise<void> {
  const port = Number(process.env.COCKPIT_PORT ?? DEFAULT_PORT)
  getDb()

  // Never let a schema replacement happen silently: the journal is the one
  // thing the core is supposed to keep (§13 rule 3).
  const schema = schemaOutcome()
  if (schema.kind === 'replaced') {
    process.stdout.write(
      '[cockpit-core] the database in COCKPIT_HOME was written by a different schema.\n' +
        '[cockpit-core] it has been moved aside, nothing was deleted:\n' +
        '[cockpit-core]   ' + schema.movedTo + '\n',
    )
  }

  const cfg = loadConfig()

  // Boot hygiene, all four consequences of running permanently (§13).
  const reaped = supervisor.reapOrphans()
  agents.reapSessions()
  const staleLeases = leases.releaseAll('core restart')
  const pruned = pruneJournal(cfg.journalRetentionDays)

  append({
    type: 'core.started',
    actor: { kind: 'system' },
    payload: {
      pid: process.pid,
      port,
      schema: schema.kind,
      reapedProcesses: reaped.reaped,
      adoptedProcesses: reaped.adopted,
      staleLeases,
      prunedEvents: pruned,
    },
  })

  const server = startServer(port)
  server.on('listening', () => {
    process.stdout.write('[cockpit-core] listening on ws://127.0.0.1:' + port + '\n')
  })
  server.on('error', (e) => {
    process.stderr.write('[cockpit-core] ' + String(e) + '\n')
    process.exit(1)
  })

  // First reconciliation: real state wins over anything cached.
  await registry.reconcile()
  pushWorkspaces()
  watcher.start(() => pushWorkspaces())

  // Periodic re-probe. Cheap, and it is what keeps §3.4 honest when things
  // change outside the cockpit entirely.
  const slow = setInterval(() => {
    void registry.reconcile().then(() => {
      pushWorkspaces()
      watcher.start(() => pushWorkspaces())
    })
  }, 60_000)

  const daily = setInterval(() => pruneJournal(loadConfig().journalRetentionDays), 6 * 3600_000)

  const shutdown = (signal: string) => {
    append({ type: 'core.stopping', actor: { kind: 'system' }, payload: { signal } })
    clearInterval(slow)
    clearInterval(daily)
    watcher.stop()
    terminals.closeAll()
    // Dev servers are deliberately NOT killed here: they belong to the user's
    // work, not to this process's lifetime (§13 rule 2). Only a explicit
    // teardown stops them.
    server.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (e) => {
    process.stderr.write('[cockpit-core] uncaught: ' + String(e?.stack ?? e) + '\n')
  })
}

void main()
