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

The window says so too: a service older than the renderer raises a banner with a
**Restart the service** button, rather than failing one command at a time with
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

# a rebase that stops is a state to work in, not an error (§3.7)
cockpit conflict show  # what it left behind, and which files still block
cockpit conflict continue   # stages what you resolved, then carries on
cockpit conflict abort      # back to the start; the autostash comes with it

# topics — the durable unit of work (§4)
cockpit topic open "Two-factor auth"   # one plan, one branch per repository
cockpit topic open "2FA" --clone-db     # ...and its own database (§10)
cockpit commit "Add the QR step"         # stage + commit, every repo at once
cockpit topic rebase two-factor-auth   # every repo onto its base, one plan
cockpit topic merge two-factor-auth --push   # merge it ONTO the base, then push
cockpit topic ls                       # every topic, running or stopped

# what a branch would be missing, before it is checked out
cockpit seed two-factor-auth             # the gitignored config it needs
cockpit db two-factor-auth               # the database it would get
cockpit topic start two-factor-auth     # servers up; refuses if something exclusive blocks it
cockpit topic stop two-factor-auth     # servers down; the branches stay
cockpit topic close two-factor-auth --remove   # close it; reversible
cockpit topic reopen two-factor-auth          # bring a closed one back
cockpit topic delete two-factor-auth          # drop the record for good
cockpit topic ls --all                        # closed ones included

# conversations are disposable; the memory is not
cockpit agent list                       # ↻ marks the resumable ones
cockpit agent resume <id> "what next"
```

## Topics, conversations, and the difference

A **topic** is the durable thing: a name, a branch of that name in every repository
it spans, one folder holding them all, a memory, and a started/stopped state. It survives
the daemon, the window and the week — that is the whole reason it has a table.

A **conversation** is the disposable thing: a list of paths, an engine, a lease. Clearing one
costs nothing because the understanding lives in the topic's memory, not in the
conversation (§6). Resuming one is the same idea from the other side: `agent resume`
hands the engine back its own conversation *and* re-reads the memory first, so it
continues from what is true now rather than from what was true on Tuesday.

**Close and delete are different verbs on purpose.** Close archives: the record, the
branches and the memory all survive, and `reopen` undoes it — so it is the safe default.
Delete drops the record for good. It refuses over uncommitted or unpushed work, an open
running conversation or servers that are still up; and `--branches` refuses again over commits not merged
into the base, because that is the one thing nothing can bring back. The topic folder
goes to the Trash, never `rm -rf` (§16).

## The whole life of a topic

```
open  →  work  →  commit  →  rebase  →  merge  →  close
```

**Commit** lives in the Diff tab, against the review it is a review of (§16), and it commits
the repository you are standing in — that one and no other. Pressing it asks a question with
your own message quoted back at you and where it will land underneath — the review already
happened in the tab behind the dialog, so what is left to check is the sentence and the
branch, not two lines of `git add`. It used to commit every
repository of the topic under one message, which was right about the gesture and wrong about
the words: two repositories in a topic are two different diffs, a field added to the API and
a form that reads it, and one sentence committed to both describes at most one of them. The
topic's other repositories are listed under the box as somewhere to go instead.

It commits to `main` if that is where you are. It used to refuse — §16's rule for agents
("jamais sur la branche principale") applied to the person using the app — and that was a
guess about how people work: plenty of repositories are committed to directly, on purpose,
by whoever owns them. The handrail is now one you put up yourself, per project, under
**Locked branches** in the project dialog: nothing is locked by default, `*` is allowed so
`release/*` covers a family, and Cockpit refuses to commit on a match. Agents are untouched
by the setting — they never commit at all, whatever it says.

The same dialog holds a **Base branch** override for when the probe is wrong: `origin/HEAD`
pointing at a `main` nobody has merged into for a year while the work happens on `develop`.
It is what topics fork from, what Send to lands on, and what counts as the protected branch
for an agent. Both settings live in `~/.cockpit`, never in the repository — a team
convention belongs in `cockpit.yaml`, which is versioned and reviewed; "do not let me commit
to main on this laptop" is not a team convention.

**Push** is the topic-wide verb, on the topic's own bar beside Send and Catch up. Both it and
Send go dead when there is nothing to do — a modal whose only job is to say "no" trains
people to dismiss modals — with the reason on the wrapper rather than the button, because a
disabled button fires no mouse events and a `title` on one is a reason nobody can read. It is the
counterpart of the above and for the same reason: a commit message describes a diff and a
topic's repositories do not share one, but a push carries no words, so doing every branch at
once invents nothing. It stops at the first refusal and keeps the branches that went — two
pushed and one rejected is two correctly pushed, and un-pushing them would be a rewrite of
someone else's remote.

The panel is a list beside a viewer, and under about 620px there is no beside left — so it
stops trying to show both: the list is the screen, a file opens over it, and the back arrow
returns. The line between the file list and the commit box is draggable like the columns are,
with a double-click for the height the box works out for itself.

**Draft** writes the first sentence for you. It reads the diff that is about to be committed
plus the repository's last ten subjects — so the message follows the convention the log
already has — and puts what comes back in the box a person types in. It never commits: §16
says an agent does not, and §12 could not attribute a commit nobody read. The box is marked
as drafted until the text is touched, and the journal keeps the fact afterwards. Anything
already typed is passed along as a hint rather than protected.

**Set aside** is the answer to "not this, not now". Committing is not the only way out of a
dirty tree, and until now it was the only one Cockpit offered — which meant a commit you did
not mean, or a terminal. It stashes across the repositories of the topic in one act, the
message field doubling as the label, and every entry is listed under the diff with the
repository, the branch, the file count and its age until you put it back or drop it. That
list is the whole design: a stash the app never mentions is how a day's work goes missing,
and it is the reason `rebase` uses `--autostash` rather than a stash of its own. An entry
with no message of its own is named by the files it holds, not by git's `WIP on <branch>:
<sha> <subject>` — that subject belongs to the commit the work sat on, and in a list it
reads as though the stash contained it.

These four verbs — and Commit, and Push, single-repository or topic-wide — ask rather than
brief. §3.7 says every operation shows its plan; it does
not say the plan has to be the first thing you read, and for a reversible one-liner a
numbered-step dialog is machinery in front of a one-word answer. So the question comes in
words — "Set this work aside?", "Drop this entry?" — with the commands one disclosure away
in the same box, before the button rather than after it. A pop that lands on a change says
so: `git stash pop` can conflict with *nothing in progress* — markers in the tree, unmerged
entries in the index, no MERGE_HEAD to continue and no rebase to abort — which is a state
the conflict panel cannot help with. The Diff tab names those files and carries the one verb
that clears them. Dropping is the one with a red
button and no undo: no restore point covers work that was never committed. Push keeps the red
button for a force-push, and lands focus on Cancel there rather than on the button that
rewrites someone else's branch. The full plan dialog stays where it belongs, in front of the
operations that rewrite history.

**Merge** is the step that used to be missing, and its absence was the hole in the middle of
the product: a topic could be opened, worked in, rebased and closed, and nothing ever put
it back on `main`. `merge` goes the other way — it brings the base *into* the branch to catch
it up. What it counts is `aheadOfBase`, not `ahead`: the second is measured against each
branch's own remote, so pushing a topic dropped it to zero while everything in it was still
unmerged — survivable while it was only a label on a button, and not once the button is
disabled by it. Merging runs in each repository itself, never in the branch's own folder: git will
not hold one branch in two checkouts, and the main checkout is already sitting on the base,
which is exactly what the layout buys you.

It fetches, fast-forwards the base, merges the topic branch `--no-ff` so the topic stays
one identifiable merge in the history, and pushes if you ask. It **halts on the first
conflict and keeps what already merged** — those repositories are genuinely done — and the
conflict arrives in the same panel a rebase conflict does. Resolve, then run it again.

**Close** then refuses over uncommitted changes, unpushed commits, an open agent session or a
running runtime, archives the record, and removes the checkouts while keeping the branches.
`CONTEXT.md` and the memory stay behind on purpose: promote what is worth keeping first (§9).

## What makes a worktree usable

`git worktree add` checks out *tracked* files. Everything git ignores is simply absent, so a
worktree of a Laravel or Vite app has no `.env`, no `auth.json`, and does not boot. Copying
them across verbatim is no better: three worktrees whose `.env` all say
`APP_URL=https://cp.test` and `DB_DATABASE=app` are three checkouts fighting over one hostname
and one database.

So opening a topic carries that config over and **rescopes the values that cannot be
shared** — the hostname, the database name, any port the app listens on. Cockpit reads what to
change out of the file rather than guessing from key names: a value pointing at the hostname
the main checkout serves on is the strongest signal there is. `DB_PORT` and `REDIS_PORT` are
left alone, because those are ports of servers the app dials *out* to.

It proposes, you approve once, and the answer is written into `cockpit.yaml`:

```yaml
worktrees:
  seed:
    - repo: cp
      copy: [.env, auth.json]
      set:
        .env:
          APP_URL: https://{{host}}
          DB_DATABASE: "{{db}}"
          VITE_PORT: "{{port:vite}}"
```

Every topic after that carries it without asking. `cockpit seed <slug>` shows what would
happen without creating anything.

**The database is the third global thing**, after the port and the hostname, and folder
isolation cannot help with it — the collision is on the server. `--clone-db` copies the main
checkout's database once per worktree, so an agent running a migration in one cannot break the
others. It is off by default because a full copy is slow and costs the disk again, and
dropping one is its own flag on delete: a merged branch can be recreated from the remote, a
dropped database cannot be recreated from anything.

## What an agent may do

`claude -p` asks for approval before it writes, and in non-interactive mode there is nowhere for
that approval to come from — so a session would explain that it needed permission and end having
changed nothing. Cockpit now launches it with an explicit allow-list instead, which is what §16
asked for all along:

```
Read Edit Write Glob Grep NotebookEdit TodoWrite
Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*)
```

Edits and searches, yes — that is the job. Of the shell, only the git commands that *read*. Not
`commit`, because §16 wants a human to see the diff first; not `push`, because §16 forbids it;
not a package manager, because an install changes the machine rather than the branch. A project
widens this in `cockpit.yaml`:

```yaml
agents:
  allow: [Read, Edit, Write, "Bash(npm test:*)"]
```

Every path in the session's scope is passed with `--add-dir`, so a two-repo session can actually
reach both repositories rather than only the first.

`codex` is left alone: its approval flags were never verified against a real binary, and guessing
one is how an agent ends up either blocked or unsandboxed.

## When a rebase stops

A conflicted rebase is not a failed command, it is a state you work in. Cockpit rebases with
`git rebase --autostash`, so uncommitted work is held by git itself and comes back when the
rebase ends — abort included. There is no window in which it is sitting in a stash nothing
mentions.

The conflict panel then has the only three verbs that end it. **Continue** is gated on
conflict markers, not on the index, so resolving a file in your editor is enough — nobody has
to remember `git add`. The panel updates itself as you edit, because the core re-probes on
every file change; a rebase advanced by hand in the terminal tab looks exactly like one
advanced by the button.

`cockpit topic rebase` does this across every repository a topic spans. It stops at the
first conflict and **keeps** what already replayed rather than rolling it back — those
repositories are genuinely done. Run it again once you have resolved: a branch already rebased
answers "up to date" and costs a fetch.

**Started vs stopped** is what lets several topics exist at once. Stopped means the
branches are on disk and agents may still run in them; started means the servers are up.
Ports are global and deterministic (§11), so portable runtimes coexist for free —
Compose and devcontainer are marked `exclusive`, and a second started topic wanting one
is refused with the offer to stop the other, rather than failing deep inside Docker.

`cockpit help` lists the rest.

## When a server does not start

Starting used to be the one act in the app you could not trust. `runtime.up`
called `spawn()` and returned `{ ok: true }` on the very next line, so the
window said *started* whether the server was booting, or had already died on a
missing dependency — and the status only corrected itself on the next probe,
long after the toast had gone. Three separate faults sat behind that, and all
three are fixed:

**The port was a suggestion.** `up` passed the port §11 allocated as `PORT` in
the environment and nothing else. Next.js reads that; **Vite does not** — it
takes `--port`, and otherwise binds 5173 whatever the environment says. That
does not fail, it *runs*, on a number nothing in the window knows about, so
health polled the allocated port forever and Preview opened a URL with nothing
behind it. Cockpit now identifies the dev server from the script's own text
(then its dependencies) and passes the port the way that server actually reads
it — `--port` for Vite, Quasar, Next, Nuxt, Astro and Angular, `PORT` for
everything else. Vite also gets `--strictPort`: the allocator already proved
the port free, so a Vite that moved to the next one has hit something Cockpit
cannot see, and failing loudly beats drifting silently.

**The health check asked the wrong address.** Vite binds `[::1]` and nothing
else, so polling `http://127.0.0.1:<port>` was refused by a server that was up
and serving. Every check now tries both loopback families and takes the first
that answers, and the URL handed to a person is `localhost`, which resolves to
whichever the server chose. The port allocator had the same blind spot — a port
an IPv6-only server was already serving on looked free — and now tests both.

**Nothing could read the output.** The supervisor has captured every dev
server's stdout into a ring buffer since it was written, and no method exposed
it: `logsFor` existed and nothing could call it. So a server that failed to
boot and one that booted looked identical from the window. `runtime.logs`
returns it now — including for processes that have already died, which is
exactly when it matters — and a `runtime-log` push streams it live, beside the
journal rather than into it.

So `runtime.up` waits, and reports what it observed rather than what it
attempted: **up** with the URL, **down** with the tail of the server's own
output, or **starting** for one that is alive and simply slow, which is not a
failure. A topic starts its repositories in parallel, because three sequential
waits would stack into something that looks like a hang.

## Servers

The fourth layer — navigate, agent, review, **run** — now has a surface. It
answers the two questions that were unanswerable: *where* and *why*.

`ports.map` has always known which workspace holds which port and nothing in
the window ever asked it, so somebody with three worktrees up had no way to
tell which was on which number short of reading `lsof`. The board is that
question answered, in names rather than ids, deliberately **across every
project** — running two topics of two different projects at once is the case
the global allocator exists for, and a board that stopped at the project
boundary would not answer what it is opened to answer. Under it sits the log of
whichever row is selected, live.

Start is also on the row itself, beside the agent's sparkle and for the same
reason: aiming at a branch should not mean selecting it and then crossing the
window to a bar.

## What is implemented

| §  | Subject | State |
|----|---------|-------|
| 3.3 | Single append-only journal, everything derives from it | done |
| 3.4 | Probe, never remember — SQLite holds journal + cache only | done |
| 3.7 | Plan shown before every git operation, undo via restore point | done |
| 16 | Commit from the review surface, one message across every repo of a topic | done |
| 4 | Merging: the topic branch onto the base, one `--no-ff` merge per repo | done |
| 3.7 | A conflicted rebase is a state, not a failure: continue / skip / abort | done |
| 3.7 | Multi-repo plans choose: all-or-nothing, or halt and keep what worked | done |
| 3.9 | Absent capability ⇒ invisible, never greyed out | done |
| 4 | Workspace as the primitive; topic as a decoration | done |
| 4 | Topic as a durable object: multi-repo, multi-day, started / stopped | done |
| 4 | One rebase across every repository a topic spans | done |
| 7 | Gitignored local config carried into a new worktree, values rescoped | done |
| 10 | One database per worktree: cloned on open, dropped on delete | done |
| 5 | Capability model with detection fallback (no manifest required) | done |
| 6 | Memory / sessions / journal kept separate; promotion in one gesture | done |
| 6 | Sessions resumable across a daemon restart, memory re-read on the way in | done |
| 7 | Agents scoped to paths, leased, never on the protected branch | done |
| 7 | A multi-repo session actually reaches every repo in its scope (`--add-dir`) | done |
| 16 | Agent command allow-list: edits and read-only git, never a commit or push | done |
| 7 | Cross-repo `CONTEXT.md` generated and fed to any multi-repo session | done |
| 8 | Runtime contract (`provision`/`up`/`preview`/`health`/`down`), `portable` + `exclusive` | done |
| 8 | `up` waits and reports what it observed: up, down with the log, or still starting | done |
| 8 | Dev server logs readable and streamed live, dead processes included | done |
| 11 | The allocated port passed the way each dev server actually reads it | done |
| 11 | Both loopback families checked — health, preview and allocation | done |
| 8 | Servers board: what is running, on which port, across every project | done |
| 8 | Start on the branch row, not only on the bar | done |
| 8 | Exclusive runtimes arbitrated: a second started topic is refused, not broken | done |
| 11 | Global, deterministic port allocation across all projects | done |
| 12 | Three-column shell, ⌘K palette, diff split by author | done |
| 13 | Core as a standalone service, version handshake, orphan reaping, log rotation | done |
| 13 | Schema versioning: a foreign/legacy database is moved aside, never deleted | done |
| 16 | Path leases, per-repo git queue, mtime check before writes | done |
| 21.4 | Worktree layout decided: grouped per topic (`worktrees/<topic>/<repo>`) | done |

Runtimes shipped: `node`, `expo`, `compose`, `herd`, `devcontainer`.
Agent engines shipped: `claude`, `codex` — normalised into one event stream (§7).

## Not implemented

- **Tickets and review** are detected and displayed, but nothing is fetched from GitHub /
  Jira yet; there is no token handling. `§16` requires the system keychain for that, and it
  has not been built.
- **CI badges** — the capability is detected, the status is not polled.
- **Conversation comparison** (§6, "sessions comparables") — they are listed, not diffed.
- **Preview opens the system browser.** Two worktrees can be up at once and the
  board says which is on which port, but comparing them side by side is still a
  matter of arranging browser windows yourself.
- **Documentation capability** (§9) — detected, not indexed or rendered.
- **Topic creation at the full setup level** creates the branch folders, the memory, the cross-repo context and the
  local config each worktree needs (§7); `--clone-db` also gives each one its own database
  (§10). It does not create the ticket — that needs the keychain first.
- **Database engines** — MySQL/MariaDB and Postgres are implemented; sqlite needs nothing,
  since its database is a file the worktree seed already carries. The clone and drop paths have
  not been exercised against a live server on this machine (no client installed), only their
  plans; a missing client is detected and reported before anything runs.
- **Packaging** (electron-builder, launchd) — the core runs in the foreground for now.

## The mark

The wordmark, the compact mark and the app icon are generated, not drawn:

```bash
pnpm --filter @cockpit/desktop logo   # the wordmark and the mark
pnpm --filter @cockpit/desktop icon   # build/icon.png and build/icon.icns
```

`apps/desktop/scripts/glyphs.mjs` holds the whole of the design: a squared bitmap face on a
12-row grid, cap height only, every stroke 3px on a 9px em — a third of the cap height, which is
the weight at which the counters close to slots and the word reads as one shape before it reads
as seven letters. Both scripts cut their shapes from it, so the icon
in the Dock cannot drift away from the mark in the rail. `logo.mjs` merges each row into
rectangles and writes the two Vue brand components (`currentColor`, so they follow the theme)
plus the two standalone SVGs used outside the app; `icon.mjs` writes the pixels itself — a
superellipse tile, a vertical gradient and the grid on top, sampled 4×4 and encoded as PNG with
nothing but `zlib` — then hands the ten sizes to `iconutil`.

The first letter is its own ink in both components. It follows `currentColor` until a placement
sets `--wm-lead`, which is how the hero wordmark gets its accent C and why nothing else does.

macOS reads a packaged app's icon from the bundle; unpackaged there is no bundle of ours, so
`electron/main.cjs` calls `app.dock.setIcon` in development. That is the only reason the Dock
does not say Electron.

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
and nothing else in the app is allowed a literal. Both appearances are written once, as CSS
`light-dark()` pairs: three `color-scheme` rules are the whole of the theme machinery, and the
dark palette is no longer stated twice with the two copies free to drift. Type is bundled rather
than borrowed — Geist and Geist Mono ship with the app, so an offline window looks the same on
every machine, and sans and mono share one skeleton because they share every row of the
workspace list. Icons are [Lucide](https://lucide.dev)
(`@lucide/vue`, tree-shaken), sized and weighted by one rule in `base.css` rather than per call
site. Every other stack choice in §14 is as specified —
TypeScript throughout, the core as its own Node process, WebSocket transport, CodeMirror 6,
ripgrep, node-pty + xterm, SQLite, chokidar, git and agents as subprocesses, YAML manifest.

## Open decisions still open

§21 is unresolved and the code takes the narrowest defensible default in each case:

1. **Name** — `cockpit` everywhere, `~/.cockpit` for local state.
2. **Memory without a topic** — any checkout may hold `.cockpit/memory.md`, a repository as
   readily as a branch of it. Cheap to keep, expensive to retrofit.
3. **Manifest composition** — single file per project. Composition is not implemented.
4. **Tree strategy** — `worktrees/<repo>/<branch>` beside the checkout, overridable per project
   via `worktrees.root`.
5. **Retention** — 30 days for the journal, configurable in `~/.cockpit/config.json`;
   `git.applied`, `git.restore_point` and `memory.promoted` are never pruned.

**§19 is still blank** — budget, continuation threshold, hard stop. The document says to fill
it before the first line of code. That line has now been written; the section has not.
