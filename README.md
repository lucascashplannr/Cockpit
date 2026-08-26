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

The app starts a core itself if none is listening, so `pnpm dev` alone is enough —
which also means the core you are talking to may be older than the code you just
edited. **After changing anything under `packages/core`, restart it:**

```bash
cockpit restart      # stops it over its own socket, starts a fresh one detached
cockpit stop         # just stops it; dev servers and their ports keep running
```

The window says so too: a core older than the renderer raises a banner with a
**Restart the core** button, rather than failing one command at a time with
`unknown_method`.

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

# features — the durable unit of work (§4)
cockpit feature open "Two-factor auth"   # one plan, a worktree per repo
cockpit feature ls                       # every feature, live or parked
cockpit feature live two-factor-auth     # servers up; refuses if something exclusive blocks it
cockpit feature park two-factor-auth     # servers down, worktrees kept
cockpit feature close two-factor-auth --remove   # archive it; reversible
cockpit feature reopen two-factor-auth          # bring a closed one back
cockpit feature delete two-factor-auth          # drop the record for good
cockpit feature ls --all                        # closed ones included

# sessions are disposable; the conversation is not
cockpit agent list                       # ↻ marks the resumable ones
cockpit agent resume <id> "what next"
```

## Features, sessions, and the difference

A **feature** is the durable thing: a name, a branch of that name in every repository
it spans, one folder holding them all, a memory, and a live/parked state. It survives
the daemon, the window and the week — that is the whole reason it has a table.

A **session** is the disposable thing: a list of paths, an engine, a lease. Clearing one
costs nothing because the understanding lives in the feature's memory, not in the
conversation (§6). Resuming one is the same idea from the other side: `agent resume`
hands the engine back its own conversation *and* re-reads the memory first, so it
continues from what is true now rather than from what was true on Tuesday.

**Close and delete are different verbs on purpose.** Close archives: the record, the
branches and the memory all survive, and `reopen` undoes it — so it is the safe default.
Delete drops the record for good. It refuses over uncommitted or unpushed work, an open
agent session or a live runtime; and `--branches` refuses again over commits not merged
into the base, because that is the one thing nothing can bring back. The feature folder
goes to the Trash, never `rm -rf` (§16).

**Live vs parked** is what lets several features exist at once. Parked means the
worktrees are on disk and agents may still run in them; live means the servers are up.
Ports are global and deterministic (§11), so portable runtimes coexist for free —
Compose and devcontainer are marked `exclusive`, and a second live feature wanting one
is refused with the offer to park the other, rather than failing deep inside Docker.

`cockpit help` lists the rest.

## What is implemented

| §  | Subject | State |
|----|---------|-------|
| 3.3 | Single append-only journal, everything derives from it | done |
| 3.4 | Probe, never remember — SQLite holds journal + cache only | done |
| 3.7 | Plan shown before every git operation, undo via restore point | done |
| 3.9 | Absent capability ⇒ invisible, never greyed out | done |
| 4 | Workspace as the primitive; feature as a decoration | done |
| 4 | Feature as a durable object: multi-repo, multi-day, live / parked | done |
| 5 | Capability model with detection fallback (no manifest required) | done |
| 6 | Memory / sessions / journal kept separate; promotion in one gesture | done |
| 6 | Sessions resumable across a daemon restart, memory re-read on the way in | done |
| 7 | Agents scoped to paths, leased, never on the protected branch | done |
| 7 | Cross-repo `CONTEXT.md` generated and fed to any multi-repo session | done |
| 8 | Runtime contract (`provision`/`up`/`preview`/`health`/`down`), `portable` + `exclusive` | done |
| 8 | Exclusive runtimes arbitrated: a second live feature is refused, not broken | done |
| 11 | Global, deterministic port allocation across all projects | done |
| 12 | Three-column shell, ⌘K palette, diff split by author | done |
| 13 | Core as a standalone service, version handshake, orphan reaping, log rotation | done |
| 13 | Schema versioning: a foreign/legacy database is moved aside, never deleted | done |
| 16 | Path leases, per-repo git queue, mtime check before writes | done |
| 21.4 | Worktree layout decided: grouped per feature (`worktrees/<feature>/<repo>`) | done |

Runtimes shipped: `node`, `expo`, `compose`, `herd`, `devcontainer`.
Agent engines shipped: `claude`, `codex` — normalised into one event stream (§7).

## Not implemented

- **Tickets and review** are detected and displayed, but nothing is fetched from GitHub /
  Jira yet; there is no token handling. `§16` requires the system keychain for that, and it
  has not been built.
- **CI badges** — the capability is detected, the status is not polled.
- **Session comparison** (§6, "sessions comparables") — sessions are listed, not diffed.
- **Documentation capability** (§9) — detected, not indexed or rendered.
- **Feature creation at C3** creates the worktrees, the memory and the cross-repo context, and
  `feature live` provisions and starts the runtimes. It does not create the database or the
  ticket — §10's "une base par workspace" is unbuilt, and tickets need the keychain first.
- **Packaging** (electron-builder, launchd) — the core runs in the foreground for now.

## The mark

The wordmark and the compact mark are generated, not drawn:

```bash
node apps/desktop/scripts/logo.mjs
```

The script carries a small bitmap font on a 12-row grid, merges each row into rectangles and
lays an ordered dither around every stroke — so the mark is reproducible, re-cuttable at any
size, and can be re-issued for another word by changing one string. It writes the two Vue brand
components (`currentColor`, so they follow the theme) and the two standalone SVGs used outside
the app.

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
system in `apps/desktop/src/styles/` — `tokens.css` holds every colour, size, radius and easing,
and nothing else in the app is allowed a literal. Icons are [Lucide](https://lucide.dev)
(`@lucide/vue`, tree-shaken), sized and weighted by one rule in `base.css` rather than per call
site. Every other stack choice in §14 is as specified —
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
