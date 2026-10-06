# Remote core — putting the core on a home server

Status: plan, nothing built. Written 2026-10-05 against v0.5.0 (protocol 2.16).

This is level L4 of `cockpit-projet.md` §10: the window stays on the Mac, the core
runs on another machine. Out of scope here: a web client, a mobile client,
per-project containers, per-topic environments.

Everything marked **verified** was read in the code. Everything marked **untested**
is a reasoned expectation that the spike in Phase 0 exists to confirm.

---

## 1. What you get, and what you do not

With the core on the home server:

- Projects, Topics, conversations, terminals and dev servers live on the server and
  survive the laptop being closed.
- Any Mac with the app and network access to the server opens the same state.
- Agents, builds and dev servers use the server's CPU and memory, not the laptop's.

Not included:

- No access without a window. Nothing notifies you while the app is closed.
- No offline work on remote projects.
- A conversation cannot cover a local Repository and a remote one together: the
  engine is one process on one machine, and `--add-dir` is a local path.

---

## 2. Where the code stands

| Area | State | Where |
|---|---|---|
| Window ↔ core transport | One WebSocket, version handshake first. The renderer has no filesystem. **verified** | `packages/core/src/server.ts:1014`, `apps/desktop/src/core/client.ts` |
| Core address in the window | Hard-coded `ws://127.0.0.1:<port>` | `apps/desktop/src/core/store.ts:95` |
| Core bind address | Hard-coded `127.0.0.1`, no authentication | `packages/core/src/server.ts:1016` |
| App start-up | Probes the port; if something answers it adopts it, otherwise spawns a core | `apps/desktop/electron/main.cjs:228` |
| Port choice | `COCKPIT_PORT`, else 7717 installed / 7718 in development | `apps/desktop/electron/main.cjs:30` |
| Attachments | Travel as base64 inside the request, written under `COCKPIT_HOME` by the core. Already remote-safe. **verified** | `AttachmentInput` in `packages/shared/src/model.ts:835` |
| Folder pickers | Native dialog on the window's machine, returns a local path | `preload.cjs` `pickFolder`; used by `ProjectDialog`, `AddRepoDialog`, `NewProjectDialog`, `SettingsDialog` |
| Open in IDE / Finder | Executed by the core, on the core's machine | `workspace.openIn`, `packages/core/src/server.ts:185-220` |
| Preview URLs | `http://localhost:<port>`, relative to the core's machine | `packages/core/src/runtime/index.ts` |
| Port allocation | Global and deterministic, range 7800–8799, configurable | `packages/core/src/ports.ts`, `portRange` in `config.ts` |
| Core runtime | Runs under Electron's Node because `better-sqlite3` and `node-pty` are built for that ABI | README "One runtime", `scripts/daemon.mjs` |
| Core bundle | One ESM file, natives external, target node20 | `apps/desktop/scripts/bundle-core.mjs` |
| Linux | Never run there. Release targets are macOS and Windows only | `.github/workflows/release.yml` |

The first row is why this is weeks and not months. The last two rows are where the
first surprises will come from.

---

## 3. Target architecture

```
  Mac                                   Home server (Linux)
 ┌──────────────────────┐              ┌─────────────────────────────────┐
 │ Cockpit window        │   WebSocket  │ core (system service)            │
 │  host: "home"         │◄────────────►│  git · files · watcher · journal │
 │                       │  over a      │  engine (claude) · terminals     │
 │ port forwards         │  private     │  dev servers on 127.0.0.1:78xx   │
 │  localhost:78xx ──────┼──network────►│                                  │
 └──────────────────────┘              │ ~/.cockpit   ~/dev/<projects>    │
                                        └─────────────────────────────────┘
```

Three decisions, with the reason for each:

1. **Private network, not a public endpoint.** The core runs shells and agents for
   whoever connects; it is remote code execution by design. Use Tailscale or
   WireGuard between the Mac and the server. Do not route it through Dokploy's
   Traefik.
2. **A service on the host, not an ordinary Dokploy app.** The core needs your
   toolchains, your git credentials, the engine's login, and `docker compose` for
   projects that use it. Inside a plain container it has none of these, and bind
   mounts started through a mounted Docker socket resolve against host paths, not
   container paths. Dokploy stays useful for what you deploy, not for the core.
3. **Previews by forwarding the same port number.** A dev server on the server's
   `127.0.0.1:7843` is forwarded to the Mac's `127.0.0.1:7843`. Every URL the core
   prints, every link in a terminal and every OAuth redirect keeps working
   unchanged. Dev servers stay bound to loopback on the server.

---

## 4. Phase 0 — the spike (half a day to one day, no app changes)

Goal: see the real app drive a core on the server, and collect what breaks on Linux.

It needs no change to the app because of the adopt-if-listening behaviour: if a
tunnel is listening on the port the app probes, the app adopts the remote core.

### On the server

Prerequisites: Node 20.11+ (22 is fine), pnpm 11, git, `python3 make g++` (for
`node-pty`), `lsof`, and `claude` installed and logged in as the user that will run
the core.

```bash
git clone <cockpit repo> ~/cockpit
```

```bash
cd ~/cockpit && pnpm install --filter @cockpit/core...
```

The filter matters: it skips the desktop package, so Electron is not downloaded and
`rebuild-native.mjs` does not rebuild the natives for Electron's ABI. The natives are
then built for the server's own Node, which is what will run the core. **untested** —
the root `postinstall` (`scripts/postinstall.mjs`) still runs and may need a guard.

```bash
sudo sysctl fs.inotify.max_user_watches=524288
```

```bash
cd ~/cockpit && ulimit -n 65536 && COCKPIT_PORT=7719 pnpm --filter @cockpit/core start
```

Expected line: `[cockpit-core] listening on ws://127.0.0.1:7719`.

### On the Mac

```bash
ssh -N -L 7719:127.0.0.1:7719 <user>@<server>
```

```bash
COCKPIT_PORT=7719 pnpm dev
```

The app should log `core already running on 7719` and open on an empty project list.
Port 7719 keeps it apart from the local cores on 7717 and 7718.

### What to try, in this order

1. Add a project from a clone URL (the clone flow takes a URL; the folder flow will
   offer a Mac path, which is wrong — see Phase 1, step 4).
2. Open a terminal. Type. Judge the latency.
3. Start a conversation, approve a permission, attach an image.
4. Open the Diff, commit, look at the commit graph.
5. Start a dev server, then forward its port by hand
   (`ssh -N -L <port>:127.0.0.1:<port> …`) and open the preview.
6. Close the app, reopen it, confirm the conversation and the server are still there.

### What is expected to misbehave

| Symptom | Cause | Fixed in |
|---|---|---|
| Folder pickers return Mac paths the server does not have | native dialog is local | Phase 1, step 4 |
| "Open in IDE" and "Reveal in Finder" do nothing or fail | run on a headless server | Phase 1, step 5 |
| Preview links do not load | port not forwarded | Phase 1, step 6 |
| "Restart service" kills the SSH tunnel | it stops whatever listens on the port (`main.cjs` `killPort`) | Phase 1, step 3 |
| Move to Trash fails or deletes outright | macOS path uses Finder (`registry.ts:361`, `files.ts:152`); the other branch is unverified on Linux | Phase 1, step 1 |
| Terminal command history missing in bash | the integration is zsh-only (`terminalHistory.ts:76`) | accept, or install zsh |
| File changes not picked up, or `ENOSPC` | `fs.watch` recursive uses one inotify watch per directory on Linux | the `sysctl` above; otherwise Phase 1, step 1 |
| `claude` not found | the service's PATH is not a login shell's | Phase 1, step 2 |

Phase 0 ends with a list: what worked, what is in the table, and anything that is not.
That list decides whether Phase 1 is worth doing.

---

## 5. Phase 1 — a real feature (about 1.5 to 2 weeks)

One window talks to one core, local or remote, chosen in settings.

### Step 1 — the core runs on Linux as a first-class target (2–3 days)

- Fix what Phase 0 found.
- Trash on Linux: decide between `gio trash`, a `.Trash-<uid>` move, or refusing with
  a clear message. Never a silent permanent delete.
- Watcher: confirm `fs.watch(root, { recursive: true })` reports changes for a large
  repository within the inotify limit; if it does not, ignore `node_modules`-class
  directories at the watch level or fall back to a `git status` poll per workspace.
- Add a Linux job to CI that boots the core and runs the handshake.

### Step 2 — package and install the core on a server (2 days)

- Extend `bundle-core.mjs` with a standalone output: `core.mjs` plus
  `better-sqlite3` and `node-pty` built for Node 20 on linux-x64, in one tarball.
  The server then needs Node, not the repository.
- A systemd unit:

  ```ini
  [Unit]
  Description=Cockpit core
  After=network-online.target

  [Service]
  User=<you>
  Environment=COCKPIT_PORT=7717
  Environment=COCKPIT_APP_VERSION=<version>
  ExecStart=/bin/bash -lc 'exec node /opt/cockpit/core.mjs'
  Restart=always
  LimitNOFILE=65536
  KillMode=process

  [Install]
  WantedBy=multi-user.target
  ```

  `bash -lc` gives the core the PATH a terminal has, which is how it finds `claude`,
  `pnpm` and the rest. `KillMode=process` keeps dev servers alive across a core
  restart, matching §13 rule 2.
- An update path: replace the tarball, `systemctl restart cockpit-core`. The
  handshake already tells the window when the core is older.

### Step 3 — hosts in the desktop app (3 days)

- A `hosts` list in the app's own settings: `{ id, name, kind: 'local' | 'remote',
  address, port, sshTarget? }`. Stored by the Electron main process, not by the core.
- `store.ts:95`: the URL comes from the selected host instead of a constant.
- `main.cjs`: `ensureCore`, `core:restart` and `killPort` apply to the local host
  only. For a remote host the main process opens and supervises the connection
  (step 6) and "Restart service" is hidden.
- `ConnectionBanner` and `ServiceDialog`: name the host, and say "unreachable — check
  the network" for a remote one instead of offering to start a service.
- Host switcher in the window, and "New window on host…" so a local window and a
  remote window can sit side by side (see Phase 2).

### Step 4 — choosing folders on the core's machine (1.5 days)

- New RPC `host.browse { path } → { path, parent, dirs[] }`, listing directories
  only, starting at the core's home or `devRoot`.
- A small picker component used by the four dialogs when the host is remote; the
  native dialog stays for the local host.
- Bump the protocol minor version.

### Step 5 — opening things from a remote host (1 day)

- `workspace.openIn` target `finder`: hidden for a remote host.
- Target `ide`: the window opens
  `vscode://vscode-remote/ssh-remote+<sshTarget><absolute path>` locally, so VS Code
  attaches over Remote-SSH. Other editors: hidden unless they have an equivalent.
- Target `browser`: opened by the window, not by the core.

### Step 6 — connection and previews (2–3 days)

- The Electron main process runs one supervised `ssh -N` to the host carrying the
  core's port, with keepalive and automatic reconnect. With Tailscale the WebSocket
  can also be reached directly; keep SSH as the single supported path first.
- Previews: subscribe to the core's server list (`runtime.servers`, `ports.map`) and
  add or remove `-L <port>:127.0.0.1:<port>` forwards as servers start and stop. Use
  an SSH control socket so forwards are added without reconnecting.
- Give the remote core a `portRange` that does not overlap the local core's
  (for example 8800–9799) so both can be forwarded on one Mac without collisions.
- Turn on `perMessageDeflate` on the WebSocket for remote hosts; diffs and
  transcripts compress well and the link is no longer loopback.

### Step 7 — safety and operations (1.5 days)

- Core: `COCKPIT_BIND` to choose the listen address, default `127.0.0.1`. Refuse to
  bind anything else without a `COCKPIT_TOKEN`; the window sends the token as its
  first message and the core closes the socket otherwise. With SSH-only access the
  bind stays on loopback and the token is optional.
- Backup of `COCKPIT_HOME` on the server (database, attachments, memory, checkpoint
  stores): a nightly `restic` or `rsync` job. Code is covered by git remotes; the
  journal and the memories are not.
- A line in the Service sheet with the host's disk and load, since the server is now
  something to watch.

---

## 6. Phase 2 — local and remote together

Two ways, very different in cost.

**A. One window per host (1–2 days, included in step 3).** Each window has its own
host and its own store. Local projects in one window, home-server projects in
another. No change to the 23 files and roughly 150 call sites that use the single
`client` export.

**B. One merged window (1.5 to 2 weeks, optional).** One project rail showing
projects from several cores. Requires a client per host, every id qualified by host,
and every one of those call sites routed through the project's host. A project still
belongs to one core; mixing a local Repository and a remote one inside a single
project is a further step on top of this.

Recommendation: ship A, use it, and build B only if switching windows turns out to
be a real annoyance.

---

## 7. Effort summary

| Phase | Content | Estimate |
|---|---|---|
| 0 | Spike over an SSH tunnel, no app changes | 0.5–1 day |
| 1 | Linux core, packaging, hosts, folder picker, open-in, previews, safety | 1.5–2 weeks |
| 2A | One window per host | included in Phase 1 |
| 2B | Merged window | 1.5–2 weeks, optional |

Estimates come from reading the code, not from a prototype. Phase 0 is cheap
precisely so that it can correct them.

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Core has Linux-only bugs beyond the known list | High, low severity each | Phase 0 finds them before anything is designed around them |
| Terminal latency from outside the home network | Depends on the uplink | Measure in Phase 0 from a phone hotspot; keep latency-sensitive projects local |
| inotify limits on large repositories | Medium | Raise the sysctl; poll fallback |
| Home server down, or home connection down | Certain, eventually | `Restart=always`, wake-on-LAN, pushed branches; local projects are unaffected |
| Exposure of the core | Severe if it happens | Loopback bind + private network; token required for any other bind |
| Window and core drift apart in version | Certain | Handshake exists; update the core from the tarball when the banner says so |
| Engine login expires on the server | Occasional | Surface the engine's auth error in the conversation; re-login over the terminal |

---

## 9. Open questions

1. Which user runs the core on the server, and where do projects live
   (`devRoot`)?
2. Tailscale, WireGuard, or SSH exposed on the router? The plan assumes SSH is
   reachable over a private network.
3. Do existing local projects move to the server, or do new ones start there? Moving
   means cloning on the server; conversations, memories and the journal do not
   transfer between cores today.
4. Is one window per host acceptable for the first months?
