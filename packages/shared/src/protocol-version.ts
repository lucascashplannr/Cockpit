/**
 * Handshake between interface and core (§13, "poignée de main de version").
 * MAJOR must match exactly: a mismatch means the UI refuses to talk to the
 * core rather than mis-decoding it. MINOR may differ (additive changes only).
 */
/**
 * 2.5 — `GitState.behindBase`. Not a new method, but the same failure it
 * guards against: a core that has not been restarted sends no such field, the
 * window reads it as zero, and Catch up says "already up to date" while the
 * base has moved on. A missing number that looks like a real one is worse than
 * a missing method, which at least names itself.
 *
 * 2.6 — the `pull` operation. `git.plan` is one method whatever the verb, so an
 * older core does not answer `unknown_method`: it falls through its own switch
 * and returns a plan with no steps at all, which reads as "there is nothing to
 * do" rather than as a daemon nobody restarted.
 *
 * 2.7 — the `agent-progress` push. Additive, and an older core simply never
 * sends it — but what is then missing is the number that tells a long turn
 * apart from a hung one, and a window silently short of it would have nobody
 * to ask. Bumped so the banner says which half is out of date.
 *
 * 2.8 — `core.logs`, and `CoreStatus` says which app started the service, where
 * it keeps its data and what PATH it runs with. The window compares that
 * version with its own: a service left running across an update is the one
 * that has to be restarted.
 *
 * 2.9 — `declare.forgetGuess`, and `Declarations.guesses`. An older core sends
 * no guesses, so the sheet would go back to saying "nothing declared" over a
 * repository that has a Start.
 *
 * 2.10 — `fs.readImage`, so the Code tab can show an image rather than open
 * it as an empty text file.
 *
 * 2.11 — `agent.find`, `agent.restore`, and `agent.delete` answering `kept`: a
 * conversation with a memory is hidden rather than deleted. An older core
 * deletes it, and the notes that name it lead nowhere.
 *
 * 2.12 — `agent.removed`, so the drawer can show what was removed but kept.
 *
 * 2.13 — `git.graph`, `git.show` and `git.showFile`, for the Commits tool.
 *
 * 2.14 — `AttachmentInput.quoted`, a passage of the thread referred to. An
 * older core drops the field and hands the engine the passage as a paste:
 * its own words, presented as new material, with nothing to say which.
 *
 * 2.15 — `terminal.open` takes a `projectId` in place of a `workspaceId`, for
 * a shell at the project's root. An older core refuses it: unknown workspace.
 *
 * 2.16 — `terminal.history` and `terminal.forget`. An older core also records
 * nothing: the shell it opens is not asked what it runs.
 *
 * 2.17 — `agent.permission` takes `answers`, and agents are handed
 * `AskUserQuestion`. An older core never offers the tool, so nothing is asked.
 *
 * 2.18 — `agent.memorize`, behind the composer's `/memorize`.
 *
 * 2.19 — `agent.summary`, and a `conversation` quote: another conversation of
 * the project tagged with `@`. An older core has no summary to give.
 *
 * 2.20 — `topic.open` takes `branch`, an existing branch to open the topic
 * on. An older core ignores it and forks a new branch named after the topic.
 *
 * 2.21 — `topic.open` takes `bases`, a base per repository. An older core
 * ignores it and forks every repository from the one `base`.
 *
 * 2.22 — `GitState.incoming`, and for the reason 2.5 gives: an older core
 * sends no such field, the window reads it as zero, and Pull never appears.
 *
 * 2.23 — `topic.rebase` takes `bases`, a base per repository, and its plan
 * carries `targets`. An older core ignores the first and replays every
 * repository onto the one `base`; without the second the rows say no count.
 */
export const PROTOCOL_VERSION = { major: 2, minor: 23 } as const

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
