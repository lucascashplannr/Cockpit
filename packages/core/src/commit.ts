import { lstatSync } from 'node:fs'
import { basename, join } from 'node:path'
import { newId } from '@cockpit/shared'
import { commitRuleLines, normalizeCommitRules } from '@cockpit/shared'
import type { CommitPreview, PlanPreview, PlanStep } from '@cockpit/shared'
import { loadConfig } from './config.js'
import { run, which } from './exec.js'
import { git } from './git.js'
import { append } from './journal.js'
import * as plans from './plans.js'
import { isProtected } from './protect.js'
import * as registry from './registry.js'

/**
 * §16 — "revue humaine du diff avant tout commit."
 *
 * The review was built and the commit was not, which left the loop open at
 * exactly the point it mattered: `topic.close` refuses over uncommitted
 * changes, so Cockpit blocked you on a state it gave you no way to leave. You
 * had to go to a terminal, which is the one thing this window exists to avoid.
 *
 * A topic spans repositories, so committing is one act across all of them
 * with one message — the same shape as opening it and rebasing it. Repos with
 * nothing staged are skipped rather than made to carry an empty commit.
 */

/**
 * What a commit would cover, without saying anything about the message. The
 * preview and the draft both ask this question and neither has a message to
 * give — a scope is not a commit until someone has written one.
 */
export interface CommitScope {
  /** Commit in every repository of this topic. */
  topicId?: string
  /** Or in exactly these workspaces. One of the two is required. */
  workspaceIds?: string[]
  /**
   * Stage everything first, untracked included. Off means "commit what is
   * already staged", which is the answer when the Diff tab was used to pick.
   */
  all: boolean
}

export interface CommitInput extends CommitScope {
  message: string
  /**
   * Only these paths, whatever else is staged or changed — the files ticked in
   * the Diff tab. One repository only: a path means nothing across several.
   */
  paths?: string[]
  /** Rewrite the last commit instead of adding one. Needs no files. */
  amend?: boolean
  /** Push the branch once the commit is made — same plan, one question. */
  push?: boolean
}

/**
 * What each repository would contribute, before anything is written.
 *
 * Re-probed rather than read off the registry (§3.4). The cached state is
 * refreshed by the watcher and by a 60-second reconcile, and either is too
 * late here: a stale count means offering to commit files that are no longer
 * there, or refusing with "nothing to commit" over work that plainly exists.
 */
export async function preview(input: CommitScope): Promise<CommitPreview[]> {
  const out: CommitPreview[] = []
  for (const target of resolveTargets(input)) {
    const w = (await registry.refreshGit(target.id)) ?? target
    const g = w.git
    if (!g) continue
    const staged = g.staged
    const unstaged = g.unstaged + g.untracked
    out.push({
      workspaceId: w.id,
      repo: w.name,
      branch: g.branch,
      staged,
      unstaged,
      // §16 — a commit on the protected branch is the one this must never make.
      // The branch name check is the window's approximation; `plan` re-checks.
      willCommit: input.all ? staged + unstaged > 0 : staged > 0,
      conflicted: g.conflicted,
    })
  }
  return out
}

function resolveTargets(input: CommitScope) {
  if (input.workspaceIds?.length) {
    return input.workspaceIds.map((id) => registry.requireWorkspace(id)).filter((w) => w.repo)
  }
  if (!input.topicId) throw new Error('commit needs a topic or a set of workspaces')
  const f = registry.getTopic(input.topicId)
  if (!f) throw new Error('unknown topic: ' + input.topicId)
  return registry
    .allWorkspaces(f.projectId)
    .filter((w) => w.topicId === input.topicId && w.repo && w.kind !== 'group')
}

/**
 * §3.7 — a commit is an operation, so it gets a plan like everything else.
 * The message is quoted as one argument; `tokenize` honours quotes, and a
 * message with a space in it was the first thing that needed that to be true.
 */
export async function plan(input: CommitInput): Promise<{
  ok: boolean
  detail: string
  plan: PlanPreview | null
  preview: CommitPreview[]
}> {
  const message = input.message.trim()
  if (!message) return { ok: false, detail: 'a commit needs a message', plan: null, preview: [] }
  if (message.includes('"')) {
    // The plan is a shown command; a double quote in the message would break
    // the argv it is tokenized back into. Refusing beats committing something
    // other than what was previewed.
    return {
      ok: false,
      detail: 'the message cannot contain a double quote — the plan shows the exact command it runs',
      plan: null,
      preview: [],
    }
  }

  const paths = input.paths?.length ? [...new Set(input.paths)] : null
  if (paths?.some((p) => p.includes('"'))) {
    return { ok: false, detail: 'a path with a double quote in it cannot be committed from here', plan: null, preview: [] }
  }

  // preview() re-probes, so the rows below are current and the targets can be
  // read back from the registry afterwards without a second round of git.
  const rows = await preview(input)
  const targets = resolveTargets(input)
  if (paths && targets.length !== 1) {
    return { ok: false, detail: 'picking files works in one repository at a time', plan: null, preview: rows }
  }
  const steps: PlanStep[] = []
  const warnings: string[] = []
  const repos: string[] = []
  /** Where each commit lands, said afterwards: how it is worded depends on
   *  whether there turned out to be one repository or several. */
  const landings: { repo: string; branch: string | null }[] = []

  for (const w of targets) {
    const row = rows.find((r) => r.workspaceId === w.id)
    if (!row) continue

    if (row.conflicted > 0) {
      return {
        ok: false,
        detail: w.name + ' has ' + row.conflicted + ' unresolved conflict(s); finish that first',
        plan: null,
        preview: rows,
      }
    }

    // This used to refuse any commit on the repository's default branch, for
    // everyone, always — §16's rule for agents applied to the person using the
    // app. It is the right rule for an agent and the wrong one for a person:
    // plenty of repositories are committed to directly, on purpose, by whoever
    // owns them, and an app that refuses is not protecting them from anything.
    //
    // What replaces it is a handrail you put up yourself, per repository.
    // Agents are unaffected — they never commit at all (§16, `DEFAULT_DENY`).
    if (isProtected(w, row.branch)) {
      warnings.push(
        row.branch + ' is protected in ' + w.repoName + '. ' +
          'Commit on another branch and Send it, or unprotect ' + row.branch + ' from the branch menu.',
      )
      continue
    }
    const files = paths ? paths.length : input.all ? row.staged + row.unstaged : row.staged
    // An amend with nothing new is a message rewrite, and a real thing to want.
    if (!input.amend && (paths ? !paths.length : !row.willCommit)) continue

    const g = registry.requireWorkspace(w.id).git
    const onRemote = !!g && g.upstream === 'origin/' + row.branch && g.ahead === 0
    if (input.amend && !g?.lastCommit) {
      return { ok: false, detail: w.name + ' has no commit to amend', plan: null, preview: rows }
    }

    const quote = (list: string[]) => ' -- ' + list.map((p) => '"' + p + '"').join(' ')
    const spec = paths ? quote(paths) : ''
    // Only what is still on disk needs adding: `git commit -- <path>` records a
    // deletion by itself, and `git add` on a deletion already staged has
    // nothing left to match and stops the whole plan.
    const present = paths?.filter((p) => onDisk(join(w.path, p))) ?? []
    if (present.length) {
      steps.push({
        title: w.name + ': stage ' + present.length + ' file(s)',
        command: 'git add -A' + quote(present),
        cwd: w.path,
        destructive: false,
      })
    } else if (!paths && input.all) {
      steps.push({
        title: w.name + ': stage everything',
        command: 'git add -A',
        cwd: w.path,
        destructive: false,
      })
    }
    steps.push({
      title: w.name + (input.amend ? ': amend the last commit' : ': commit ' + files + ' file(s)'),
      command: 'git commit' + (input.amend ? ' --amend' : '') + ' -m "' + message + '"' + spec,
      cwd: w.path,
      // Rewriting a commit that is already on the remote is the one version of
      // this that cannot be quietly walked back.
      destructive: !!input.amend && onRemote,
    })
    if (input.amend && onRemote) {
      warnings.push(
        'The last commit of ' + w.name + ' is already on origin. Amending rewrites it, ' +
          'so the next push has to force.',
      )
    }

    if (input.push) {
      if (!row.branch) {
        return { ok: false, detail: w.name + ' is not on a branch; there is nothing to push', plan: null, preview: rows }
      }
      const origin = await git(w.path, ['remote', 'get-url', 'origin'])
      if (!origin.ok) {
        return { ok: false, detail: w.name + ' has no origin remote to push to', plan: null, preview: rows }
      }
      const own = g?.upstream === 'origin/' + row.branch
      // Rewritten, not merely behind: commits origin has that this branch
      // never held are somebody else's, and no push here replaces those.
      const rewritten = (g?.behind ?? 0) > 0 && (g?.incoming ?? 0) === 0
      const force = own && ((!!input.amend && onRemote) || rewritten)
      steps.push({
        title: w.name + (force ? ': force-push (with lease) ' : ': push ') + row.branch,
        command: force ? plans.FORCE_PUSH + row.branch : 'git push -u origin ' + row.branch,
        cwd: w.path,
        destructive: force,
      })
      if (own && (g?.incoming ?? 0) > 0) {
        warnings.push('origin/' + row.branch + ' has ' + g!.incoming + ' commit(s) you do not have; the push will be refused until you pull.')
      }
    }
    repos.push(w.name)
    // Asked as a question now rather than read as a list of steps, and the one
    // thing a list of steps never said out loud is where the commit lands.
    // Which repository and which branch is the whole of what there is to get
    // wrong here — the message is already on screen, and the diff was the
    // screen before it.
    landings.push({ repo: w.name, branch: row.branch })
  }

  if (!steps.length) {
    return {
      ok: false,
      detail: warnings.length ? warnings.join(' ') : 'nothing to commit',
      plan: null,
      preview: rows,
    }
  }

  // Where it lands, in one sentence, and first: the count and the message are
  // already in the question. What goes in (all, staged, picked) was said on the
  // control that chose it, and "and push" is in the title — saying either again
  // here only buried the warnings that follow.
  const branches = new Set(landings.map((l) => l.branch))
  const into =
    branches.size === 1
      ? and(landings.map((l) => l.repo)) + (landings[0]!.branch ? ', on ' + landings[0]!.branch : '')
      : and(landings.map((l) => l.repo + (l.branch ? ' on ' + l.branch : '')))
  warnings.unshift('Into ' + into + '.')

  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: input.amend ? 'amend' : 'commit',
    steps,
    warnings,
    capturesRestorePoint: false,
    repos,
    // A commit that fails in the third repo leaves the first two committed,
    // and that is correct: those commits are good work, and `git reset` to
    // "recover" from a hook rejecting one repo would throw them away.
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: targets.map((w) => w.id) })
  return { ok: true, detail: repos.length + ' repository(ies)', plan: p, preview: rows }
}

export { basename }

/** "a", "a and b", "a, b and c". */
function and(list: string[]): string {
  return list.length < 2 ? (list[0] ?? '') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
}

/** lstat, not exists: a dangling symlink is still a file to commit. */
function onDisk(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * §16 — taking the last commit back, while it is still only here.
 *
 * `git reset --soft` to its parent: the commit goes, and what it held comes
 * back staged, exactly as it stood the moment before it was made. Nothing in
 * the working tree is touched, so there is no work this can lose.
 *
 * Only HEAD, and only while no remote has it. An older commit is a rebase, and
 * a pushed one is somebody else's history too — neither is an undo.
 */
export async function undoPlan(input: { workspaceId: string; hash: string }): Promise<{
  ok: boolean
  detail: string
  plan: PlanPreview | null
}> {
  const no = (detail: string) => ({ ok: false, detail, plan: null })
  const target = registry.requireWorkspace(input.workspaceId)
  if (!target.repo) return no('this is not a repository')
  // Re-probed, for the reason `preview` gives: the question is about HEAD as
  // it is now, not as the window last drew it.
  const w = (await registry.refreshGit(target.id)) ?? target
  const g = w.git
  if (!g) return no('git did not answer for ' + w.name)
  if (g.operation) return no(w.name + ' is in the middle of a ' + g.operation.kind + '; finish that first')
  if (g.conflicted > 0) return no(w.name + ' has ' + g.conflicted + ' unresolved conflict(s); finish that first')

  const head = await git(w.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const full = head.ok ? head.stdout.trim() : ''
  if (!full || !/^[0-9a-f]{7,64}$/i.test(input.hash) || !full.startsWith(input.hash.toLowerCase())) {
    return no('only the last commit can be undone, and this is no longer it')
  }
  const parents = await git(w.path, ['rev-list', '--parents', '-n', '1', full, '--'])
  const [, ...up] = parents.stdout.trim().split(' ').filter(Boolean)
  if (!parents.ok || up.length === 0) return no('the first commit of a repository has nothing to go back to')
  if (up.length > 1) return no('a merge is not undone from here — its changes are not one commit\'s')

  const local = await git(w.path, ['rev-list', '-n', '1', full, '--not', '--remotes', '--'])
  if (!local.ok || local.stdout.trim() !== full) {
    return no('this commit is already on a remote; undoing it here would not undo it there')
  }

  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: 'undo commit',
    steps: [{
      title: w.name + ': undo ' + full.slice(0, 7),
      command: 'git reset --soft ' + up[0],
      cwd: w.path,
      destructive: false,
    }],
    warnings: [
      'From ' + w.name + (g.branch ? ', on ' + g.branch : '') + '.',
      'Its changes come back as uncommitted, staged.',
    ],
    capturesRestorePoint: false,
    repos: [w.name],
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: [w.id] })
  return { ok: true, detail: w.name, plan: p }
}

/** The whole message of the last commit, body included — what an amend starts from. */
export async function lastMessage(workspaceId: string): Promise<string | null> {
  const w = registry.requireWorkspace(workspaceId)
  if (!w.repo) return null
  const r = await git(w.path, ['log', '-1', '--format=%B'])
  return r.ok ? r.stdout.replace(/\s+$/, '') : null
}

/* ── §16 — drafting the message, never the commit ─────────────────────────
 *
 * The message box was the last place in the loop where the window offered
 * nothing and the terminal offered plenty. Writing one by hand is fine; being
 * unable to get a first sentence out of a diff you have just read, in a window
 * whose whole premise is that an engine is already sitting next to the code,
 * was not.
 *
 * What it deliberately does not do is commit. The draft lands in the same
 * field a person types in, and what is committed is whatever stands there
 * after they have read it — because §16 says an agent never commits, and §12
 * could not attribute a commit nobody looked at.
 */

/**
 * Enough diff to write about; past this, the summary carries the rest. In
 * characters, across every repository of the commit — about 100k tokens.
 *
 * It was 120k characters, and an ordinary docs commit (2.6k lines of prose,
 * 135k characters) tripped it every time: the draft came with a warning to
 * distrust it over a diff the engine could have read whole in a few seconds.
 * The cap is for the change that is mostly generated or moved code, not for
 * a day's writing.
 */
const DRAFT_DIFF_BUDGET = 400_000

/**
 * Files whose patch says nothing the filename does not. A regenerated lockfile
 * is thousands of lines and one fact, and it used to arrive first and take the
 * whole budget with it — the draft was then written from `pnpm-lock.yaml`.
 */
const DRAFT_NOISE = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Podfile\.lock|flake\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
]

/**
 * Shares a budget between pieces of unequal size: the small ones are taken
 * whole and what they leave is split between the large ones. Cutting at the
 * budget instead gave everything to whichever file git happened to list first.
 */
function allot(sizes: number[], budget: number): number[] {
  const out = new Array<number>(sizes.length).fill(0)
  const order = sizes.map((_, i) => i).sort((x, y) => sizes[x]! - sizes[y]!)
  let left = Math.max(0, budget)
  order.forEach((i, n) => {
    const take = Math.min(sizes[i]!, Math.floor(left / (order.length - n)))
    out[i] = take
    left -= take
  })
  return out
}

/** Whole lines from the start of `text`, as many as fit. */
function headLines(text: string, room: number): string {
  if (text.length <= room) return text
  const cut = text.lastIndexOf('\n', room)
  return cut > 0 ? text.slice(0, cut) : ''
}

/**
 * One file's patch, cut to `room`. The header always stays — it is the path —
 * and the room is shared between the hunks, so a file changed in five places
 * shows the start of all five rather than the whole of the first.
 */
function fitFile(patch: string, room: number): string {
  if (patch.length <= room) return patch
  const at = patch.search(/^@@ /m)
  if (at < 0) return headLines(patch, room)
  const header = patch.slice(0, at)
  const hunks = patch.slice(at).split(/^(?=@@ )/m)
  const rooms = allot(hunks.map((h) => h.length), room - header.length)
  let dropped = 0
  const kept = hunks.map((h, i) => {
    const part = headLines(h, rooms[i]!)
    dropped += h.split('\n').length - (part ? part.split('\n').length : 0)
    return part && !part.endsWith('\n') ? part + '\n' : part
  })
  return header + kept.join('') + '[… ' + dropped + ' more changed line(s) of this file not shown]\n'
}

/**
 * Fits a set of patches into the budget, file by file. Exported for the same
 * reason it is a function at all: it is the part that can be wrong without
 * git or an engine being involved.
 */
export function fitPatches(patches: string[], budget: number): { texts: string[]; truncated: boolean } {
  const files: { repo: number; text: string; noise: boolean }[] = []
  patches.forEach((patch, repo) => {
    for (const text of patch.split(/^(?=diff --git )/m)) {
      if (!text.trim()) continue
      const path = /^diff --git .* b\/(.+?)"?$/m.exec(text)?.[1] ?? ''
      const noise = DRAFT_NOISE.some((re) => re.test(path))
      files.push({ repo, text: noise ? text.slice(0, text.indexOf('\n') + 1) + '[generated — patch left out]\n' : text, noise })
    }
  })
  const rooms = allot(files.map((f) => f.text.length), budget)
  const texts = patches.map(() => '')
  let truncated = false
  files.forEach((f, i) => {
    if (f.text.length > rooms[i]!) truncated = true
    texts[f.repo] += fitFile(f.text, rooms[i]!)
  })
  return { texts, truncated }
}

export interface DraftInput extends CommitScope {
  /** What the person already knows and the diff does not say. Optional. */
  hint?: string
  /** Names this draft so `cancelDraft` can stop it. */
  draftId?: string
}

export interface DraftResult {
  ok: boolean
  detail: string
  message: string
  engine: string
  /** The diff did not fit and the draft was written from part of it. */
  truncated: boolean
  /** Stopped by `cancelDraft` — not a failure, nothing to report. */
  cancelled?: boolean
}

/**
 * What the engine is shown: the same scope the commit would take, per repo,
 * as `--stat` plus as much patch as the budget allows. Untracked files are
 * named rather than pasted — a new 2000-line lockfile would eat the budget
 * and say nothing the filename does not.
 *
 * The `--stat` is never cut: whatever happens to the patches, every file of
 * the commit is named with its size, and the draft is told to write from that.
 */
async function draftContext(
  input: DraftInput,
): Promise<{ text: string; repos: string[]; truncated: boolean }> {
  const rows = await preview(input)
  const heads: string[] = []
  const patches: string[] = []
  const repos: string[] = []

  for (const w of resolveTargets(input)) {
    const row = rows.find((r) => r.workspaceId === w.id)
    if (!row?.willCommit) continue
    repos.push(w.name)

    // `--cached` when the Diff tab was used to pick, the whole worktree when
    // "stage everything" is on: the draft has to describe what will be
    // committed, not what happens to be lying around.
    const scope = input.all ? ['HEAD'] : ['--cached']
    const [stat, patch, untracked] = await Promise.all([
      git(w.path, ['diff', ...scope, '--stat=200'], 20_000),
      git(w.path, ['diff', ...scope, '--no-color', '--unified=3'], 30_000),
      input.all
        ? git(w.path, ['ls-files', '--others', '--exclude-standard'], 20_000)
        : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
    ])

    const head = ['# repository: ' + w.name + ' (branch ' + (row.branch ?? '?') + ')']
    if (stat.stdout.trim()) head.push(stat.stdout.trim())
    const news = untracked.stdout.split('\n').filter(Boolean)
    if (news.length) head.push('new files: ' + news.join(', '))
    heads.push(head.join('\n'))
    patches.push(patch.stdout)
  }

  const fit = fitPatches(patches, DRAFT_DIFF_BUDGET)
  return {
    text: heads.map((h, i) => h + '\n\n' + fit.texts[i]).join('\n\n'),
    repos,
    truncated: fit.truncated,
  }
}

/**
 * The repository's own last ten subjects. A draft that ignores the convention
 * the log has followed for two years is one more thing to rewrite by hand, and
 * no prompt of ours knows whether this project writes `feat:` or `Fix the…`.
 */
async function styleExamples(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['log', '-10', '--format=%s'], 10_000)
  if (!r.ok) return []
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Drafts running now, by the id the window gave them. */
const drafts = new Map<string, AbortController>()

/** Stops a draft: the engine process is killed, the call answers `cancelled`. */
export function cancelDraft(draftId: string): boolean {
  const c = drafts.get(draftId)
  if (!c) return false
  c.abort()
  return true
}

export async function draftMessage(input: DraftInput): Promise<DraftResult> {
  const ctl = new AbortController()
  if (input.draftId) drafts.set(input.draftId, ctl)
  try {
    return await draftWith(input, ctl.signal)
  } finally {
    if (input.draftId) drafts.delete(input.draftId)
  }
}

async function draftWith(input: DraftInput, signal: AbortSignal): Promise<DraftResult> {
  const engine = 'claude'
  const stopped = (truncated: boolean): DraftResult =>
    ({ ok: false, detail: 'cancelled', message: '', engine, truncated, cancelled: true })
  const bin = await which(engine)
  if (!bin) {
    // Named rather than papered over: the box still takes a typed message, and
    // "nothing happened" would send someone hunting for a bug in the button.
    return {
      ok: false,
      detail: 'the claude CLI is not on PATH — type the message, or install it',
      message: '',
      engine,
      truncated: false,
    }
  }

  const ctx = await draftContext(input)
  if (signal.aborted) return stopped(ctx.truncated)
  if (!ctx.text.trim()) {
    return { ok: false, detail: 'nothing to describe', message: '', engine, truncated: false }
  }

  const first = resolveTargets(input)[0]
  const examples = first ? await styleExamples(first.path) : []
  const hint = (input.hint ?? '').trim()
  // The house style from Settings. When there is one it is the format, and the
  // log is demoted to a source of scopes and words: a repository whose history
  // predates the rule would otherwise teach the draft to break it.
  const rules = normalizeCommitRules(loadConfig().commitRules)
  const house = commitRuleLines(rules)

  const prompt = [
    'Write the commit message for the change below. Reply with the message and nothing else:',
    'no preamble, no explanation, no code fences, no quotation marks around it.',
    '',
    'Rules:',
    ...(house.length ? [] : ['- One line only, no body: imperative, concrete, at most 72 characters.']),
    '- Say what changed, and why when it fits. Never describe the diff mechanically',
    '  ("update file X"), and never invent a reason the diff does not support.',
    '- It is not a code review: do not point out bugs, risks or missing pieces.',
    ...(ctx.repos.length > 1
      ? ['- This message will be used for ' + ctx.repos.length + ' repositories (' +
         ctx.repos.join(', ') + ') committed together. Describe the change, not each repo.']
      : []),
    ...(house.length
      ? ['', 'The author\'s rules for every commit message. Follow them exactly; where anything',
         'else here disagrees with them, they win:', ...house.map((l) => '  - ' + l)]
      : []),
    ...(examples.length
      ? ['', house.length
          ? 'Recent subjects from this repository — use them for its scopes and vocabulary only; the rules above decide the format:'
          : 'Recent subjects from this repository — follow their convention:',
         ...examples.map((s) => '  ' + s)]
      : []),
    ...(hint ? ['', 'What the author says this change is about: ' + hint] : []),
    ...(ctx.truncated
      ? ['', 'NOTE: the diff is too large to show whole. The file list with line counts is complete;',
         'the larger patches are abridged where marked. Describe the change as a whole, weighing',
         'every file in the list — not only the ones whose patch you can read.']
      : []),
    '',
    '--- diff ---',
    ctx.text,
  ].join('\n')

  // §16 — the drafting call is not an agent session: no tools it could write
  // with, no lease, no checkpoint, nothing to resume. `--restricted` drops the
  // command-running tools and the project's own settings files, so a repo's
  // CLAUDE.md cannot dress this up into something other than one sentence.
  const r = await run(bin, [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--output-format', 'text',
  ], { input: prompt, timeoutMs: 90_000, maxBuffer: 256 * 1024, signal })

  if (signal.aborted) return stopped(ctx.truncated)
  if (!r.ok) {
    return {
      ok: false,
      // The CLI reports some failures — an expired sign-in among them — on
      // stdout, and an empty toast is worse than no toast.
      detail: (
        (r.stderr.trim() || r.stdout.trim()).split('\n').pop() || 'the engine failed'
      ).slice(0, 300),
      message: '',
      engine,
      truncated: ctx.truncated,
    }
  }

  const message = cleanDraft(r.stdout, rules.on ? rules : null)
  if (!message) {
    return { ok: false, detail: 'the engine returned nothing', message: '', engine, truncated: ctx.truncated }
  }

  append({
    type: 'git.message_drafted',
    actor: { kind: 'system' },
    workspaceId: first?.id ?? null,
    payload: {
      engine,
      repos: ctx.repos,
      truncated: ctx.truncated,
      subject: message.split('\n')[0],
    },
  })

  return { ok: true, detail: ctx.repos.join(', '), message, engine, truncated: ctx.truncated }
}

/**
 * Models wrap things. A fence, a "Here is the commit message:", a pair of
 * quotes around the whole line — each of those, committed verbatim, is a
 * message someone has to amend.
 *
 * The double quotes go last and unconditionally: `plan()` refuses a message
 * containing one, because the plan is shown as the exact command it runs. A
 * draft that came back with an apostrophe-as-quote would otherwise be rejected
 * by the button that offered it.
 */
function cleanDraft(raw: string, rules: { noTickets: boolean; noEmoji: boolean } | null): string {
  let t = raw.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(t)
  if (fence) t = fence[1]!.trim()
  t = t.replace(/^(here('s| is)[^\n:]*:|commit message:)\s*/i, '').trim()
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim()
  // What a rule forbids and a pattern can find is removed rather than trusted
  // to the model: a `(#123)` copied from the log is the usual way it slips in.
  if (rules?.noTickets) t = t.replace(/\s*\(#\d+\)/g, '').replace(/(^|\s)#\d+\b/g, '$1')
  if (rules?.noEmoji) t = t.replace(/\p{Extended_Pictographic}\uFE0F?\s?/gu, '')
  return t.replace(/"/g, "'").replace(/[ \t]{2,}/g, ' ').trim()
}
