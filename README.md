# Cockpit

**Une fenêtre qui connaît l'état complet du travail en cours, et depuis laquelle on déclenche tout le reste.**

Working implementation of [cockpit-projet.md](cockpit-projet.md). The design document is the
specification; this README only covers how to run what is built. Section references
throughout the source (`§6`, `§13`…) point back at it.

---

## Layout

```
packages/shared    the contract: event envelope, RPC protocol, domain model, manifest schema
packages/core      the permanent service: probing, journal, leases, runtimes, agents, git plans
packages/cli       a full client — everything is doable without the app (§3.2, §15)
apps/desktop       Electron + Vue renderer; it is only another client of the same socket
```

The boundary between `core` and every interface is a single validated WebSocket. The renderer
has no filesystem, no child processes and no git (§13, rule 1) — which is what keeps remote
execution an address change rather than a rewrite (§10, axis C).

## Requirements

- Node ≥ 20.11 (developed on 22)
- pnpm 11
- `git` on PATH; `rg` optional (search falls back to `git grep`)
- `claude` and/or `codex` on PATH for the agents capability

## Run

```bash
pnpm install

# 1. the core — a permanent service, independent of any window (§13, rule 2)
pnpm daemon

# 2. the app, in another shell
pnpm dev
```

Or use it with no app at all:

```bash
alias cockpit="npx tsx packages/cli/src/index.ts"

cockpit add .          # register a project
cockpit ls             # workspaces and their real state
cockpit diff           # changed files, split human / agent
cockpit search "route" # full text across every repo at once
cockpit plan rebase    # preview; nothing runs yet
cockpit apply <planId>
cockpit undo
```

`cockpit help` lists the rest.

## What is implemented

| §  | Subject | State |
|----|---------|-------|
| 3.3 | Single append-only journal, everything derives from it | done |
| 3.4 | Probe, never remember — SQLite holds journal + cache only | done |
| 3.7 | Plan shown before every git operation, undo via restore point | done |
| 3.9 | Absent capability ⇒ invisible, never greyed out | done |
| 4 | Workspace as the primitive; feature as a decoration | done |
| 5 | Capability model with detection fallback (no manifest required) | done |
| 6 | Memory / sessions / journal kept separate; promotion in one gesture | done |
| 7 | Agents scoped to paths, leased, never on the protected branch | done |
| 8 | Runtime contract (`provision`/`up`/`preview`/`health`/`down`), `portable` + `exclusive` | done |
| 11 | Global, deterministic port allocation across all projects | done |
| 12 | Three-column shell, ⌘K palette, diff split by author | done |
| 13 | Core as a standalone service, version handshake, orphan reaping, log rotation | done |
| 13 | Schema versioning: a foreign/legacy database is moved aside, never deleted | done |
| 16 | Path leases, per-repo git queue, mtime check before writes | done |

Runtimes shipped: `node`, `expo`, `compose`, `herd`, `devcontainer`.
Agent engines shipped: `claude`, `codex` — normalised into one event stream (§7).

## Not implemented

- **Tickets and review** are detected and displayed, but nothing is fetched from GitHub /
  Jira yet; there is no token handling. `§16` requires the system keychain for that, and it
  has not been built.
- **CI badges** — the capability is detected, the status is not polled.
- **Session comparison** (§6, "sessions comparables") — sessions are listed, not diffed.
- **Documentation capability** (§9) — detected, not indexed or rendered.
- **Feature creation at C3** creates the worktree; it does not yet provision the environment,
  the database or the ticket in one gesture.
- **Packaging** (electron-builder, launchd) — the core runs in the foreground for now.

## The local database

`~/.cockpit/cockpit.db` carries a `user_version` stamp. On startup the core either creates it,
recognises it, adopts an unstamped one it wrote itself, or — if the file belongs to a different
schema entirely — renames it to `cockpit.db.<timestamp>.bak` (WAL and SHM alongside) and starts
clean, saying so on stdout and in the journal. Nothing is ever deleted (§16), and a database
written by a *newer* core is refused rather than downgraded.

Only the journal and the cache live there; §3.4 means everything else is re-probed, so a
replaced database costs history, never state.

## Deviations from the document

**Quasar was not used** (§14 names "Electron + Quasar"). Quasar's component library is
Material-shaped, and fighting it toward the dense, hairline, keyboard-first look the document
asks for in §12 costs more than it saves. The renderer is plain Vue 3 + Vite with a small token
system in `apps/desktop/src/styles/`. Every other stack choice in §14 is as specified —
TypeScript throughout, the core as its own Node process, WebSocket transport, CodeMirror 6,
ripgrep, node-pty + xterm, SQLite, chokidar, git and agents as subprocesses, YAML manifest.

## Open decisions still open

§21 is unresolved and the code takes the narrowest defensible default in each case:

1. **Name** — `cockpit` everywhere, `~/.cockpit` for local state.
2. **Memory without a feature** — any workspace may hold `.cockpit/memory.md`, including a C0
   main checkout. Cheap to keep, expensive to retrofit.
3. **Manifest composition** — single file per project. Composition is not implemented.
4. **Tree strategy** — `worktrees/<repo>/<branch>` beside the checkout, overridable per project
   via `worktrees.root`.
5. **Retention** — 30 days for the journal, configurable in `~/.cockpit/config.json`;
   `git.applied`, `git.restore_point` and `memory.promoted` are never pruned.

**§19 is still blank** — budget, continuation threshold, hard stop. The document says to fill
it before the first line of code. That line has now been written; the section has not.
