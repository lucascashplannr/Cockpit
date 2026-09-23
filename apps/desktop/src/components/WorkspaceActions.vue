<script setup lang="ts">
import { computed } from 'vue'
import {
  AppWindow, ArrowDownToLine, ArrowUpFromLine, ChevronDown, CirclePlay, CircleStop, FileCode,
  GitCompareArrows, SlidersHorizontal, Terminal, Undo2,
} from '@lucide/vue'
import OverflowMenu from './OverflowMenu.vue'
import {
  activeWorkspace, askCommand, chooseCommand, chooseServer, chosenCommand, chosenServer, client,
  gitBusy, guard, openDeclarations, requestPlan, runningServers, state, toggleWorkspaceRuntime,
} from '../core/store.js'

/**
 * The verbs for the selected repository, on the bar of the column it is about.
 *
 * All five of them used to be drawn at once, as bare icons on a bar that was
 * already carrying the name, the branch, the counters, the servers and the
 * conversation's own instruments — eleven controls of one shape, and the bar
 * wrapped onto a second line to fit them. Nothing there was wrong; there was
 * simply no ranking, so the eye had to hover the row to read it.
 *
 * The ranking is the state itself (§3.9, one step further): the servers'
 * switch is always the one act you came for, Push appears while there is
 * something to push, Catch up while the branch is behind. Everything this
 * repository can do is in the menu beside them, named, in a fixed order — so
 * the bar gets quieter as the work gets calmer, and nothing is ever gone.
 */

const w = computed(() => activeWorkspace.value)

/**
 * A plan is running on this repository, so none of these are verbs it has
 * right now — including Start, because a server booting out of a working tree
 * that is mid-switch reads whichever half of the branch it happens to catch.
 */
const busy = computed(() => !!(w.value && gitBusy[w.value.id]))

/**
 * §8 — the declared one-shots, beside Start.
 *
 * They were in the Servers tool, under the board, and that was the wrong
 * place for the same reason the bar exists at all: a tool is where you look
 * at something, the bar is where you act on it. Pressing `build` is not part
 * of reading what is running — it is a verb this checkout has, like Push, and
 * it belongs with the other verbs whatever you happen to be looking at.
 */
const commands = computed(() => state.commands)

/**
 * The half of the split button that is a button: one command, pressed.
 *
 * Which one is the store's business (`chosenCommand`) — the last run here, and
 * otherwise the first declared. The chevron beside it is the other half, and
 * picking from it both runs the command and moves the button to it.
 */
const chosen = computed(() => chosenCommand.value)

/** The name as the button prints it: an ellipsis when it asks something first. */
const label = (c: { name: string; inputs: unknown[] }) => c.name + (c.inputs.length ? '…' : '')

/** What it will do and where — the folder is the part that surprises people. */
const runTitle = computed(() => {
  const c = chosen.value
  if (!c) return ''
  const where = c.repo ? 'in ' + c.repo : 'in the project folder'
  return 'Run ' + c.name + ' ' + where + (c.cmd ? ' — ' + c.cmd : '')
})
const preview = computed(() => w.value?.runtime?.preview ?? null)

/**
 * §3.9 — while a rebase is stopped, Catch up and Push are not verbs this
 * repository has: git refuses both, and the three that do apply are in the
 * conflict panel. Absent, not greyed out.
 */
const git = computed(() => (w.value?.git?.operation ? null : (w.value?.git ?? null)))

/**
 * `starting` counts as running: a server still coming up is one you stop, not
 * one you start again. Offering Start there is how two of the same server end
 * up fighting over one port.
 */
/**
 * The base named rather than implied — "Catch up from dev" says which way the
 * code moves, which "Rebase" never did. Falls back to the generic noun rather
 * than inventing a branch name when the probe has not answered yet.
 */
/**
 * §3.9 — the same rule the topic bar got: nothing to push, nothing to press.
 *
 * A branch with no upstream is not "nothing to push" even at zero commits
 * ahead — it has never been sent anywhere, and `git push -u` is what sends it.
 * That is the one case where the counter reads 0 and the verb still means
 * something.
 */
const canPush = computed(() => {
  const g = git.value
  return !!g && (g.ahead > 0 || !g.upstream)
})

/** Honest in both states, and when it is off it says why. */
const pushTitle = computed(() => {
  const g = w.value?.git
  if (!g) return 'Push this branch'
  if (g.ahead) return 'Push this branch — ' + g.ahead + ' commit(s) ahead'
  return g.upstream
    ? 'Nothing to push: ' + g.upstream + ' already has this branch'
    : 'Push this branch — no upstream yet, this would set one'
})

/**
 * §4 — which of the two "you are behind" this checkout can actually be, and
 * they are not alternatives to choose between so much as two different facts.
 *
 *   the base moved     → Catch up, `behindBase` commits
 *   your remote moved  → Pull, `behind` commits
 *
 * Both at once is a real state — a pushed branch a colleague added to, on a
 * base that also moved — and then both are offered, each with its own number.
 * What is *not* a state is being on the base and offered a Catch up: you
 * cannot replay a branch onto itself, and the commits `origin/main` has that
 * `main` does not are a pull. The core answers `behindBase: null` there, and
 * absent rather than disabled is §3.9.
 */
/** Catch up has a distance to close: a base, and one that is not this branch. */
const canCatchUp = computed(() => git.value?.behindBase != null)
const behindBase = computed(() => git.value?.behindBase ?? 0)

/**
 * §4 — the other direction of "behind", and the reason `behind` had to stop
 * being the number Catch up reads.
 *
 * Somebody else pushed to *this* branch: nothing to do with the base, and no
 * verb covered it. Offered only when there is something to pull, and only when
 * the upstream really is this branch's own remote — a topic branch tracks
 * `origin/<base>` until its first push, and pulling *that* is Catch up wearing
 * a wrong name.
 *
 * In the menu rather than on the bar because it is occasional: a branch two
 * people work on at once is the exception, and the bar is for the verbs of
 * every day.
 */
const canPull = computed(() => {
  const g = git.value
  return !!g && !!g.branch && g.upstream === 'origin/' + g.branch && g.behind > 0
})

const pullLabel = computed(() => {
  const g = git.value
  return 'Pull ' + (g?.branch ?? 'this branch') + ' from origin'
})

/** Only ever drawn while there is something to pull, so it says how much and
 *  from where rather than why it is not there. */
const pullTitle = computed(() => {
  const g = git.value
  if (!g) return pullLabel.value
  return pullLabel.value + ' — ' + g.behind + ' commit(s) on ' + g.upstream + ' you do not have'
})

const catchUpTitle = computed(() => {
  const g = w.value?.git
  const from = g?.base ? 'Catch up from ' + g.base : 'Catch up with the base'
  if (!g) return from
  const n = g.behindBase ?? 0
  return n ? from + ' — ' + n + ' commit(s) behind' : from + ' — already up to date'
})

/* ── the switch (§8) ──────────────────────────────────────────────────
 *
 * The same split as the Run button, for the same reason and with one
 * difference: servers have a meaningful *all*, so that is what the button
 * points at until you pick otherwise. Picking one leaves it there, and
 * `chosenServer` falls back to all of them the moment that name stops being
 * declared.
 */
const servers = computed(() => state.servers)
const alive = computed(() => runningServers(w.value))
const target = computed(() => chosenServer.value)

/** Only worth a menu where there are names in it — see `runtime.servers`. */
const pickable = computed(() => servers.value.length > 0)

/**
 * `starting` counts as running: a server still coming up is one you stop, not
 * one you start again. Offering Start there is how two of the same server end
 * up fighting over one port.
 *
 * Pointed at one server, the question is that server's own process rather
 * than the workspace's status word — `up` is a statement about everything on
 * `start:`, and answering with it would draw Stop on a `worker` that is down
 * because `web` happens to be serving.
 */
const running = computed(() =>
  target.value
    ? alive.value.has(target.value)
    : w.value?.runtime?.status === 'up' || w.value?.runtime?.status === 'starting',
)

/** What the left half says: the server it is pointed at, or the plain verb. */
const switchLabel = computed(() => {
  if (target.value) return target.value
  return w.value?.runtime?.status === 'starting' ? 'Starting' : running.value ? 'Stop' : 'Start'
})

const switchTitle = computed(() => {
  const verb = running.value ? 'Stop' : 'Start'
  if (!target.value) return running.value ? 'Stop the servers' : 'Start the servers'
  const s = servers.value.find((x) => x.name === target.value)
  const where = s?.port ? ' — port ' + s.port : s?.url ? ' — ' + s.url : ''
  return verb + ' ' + target.value + where
})

/** The state dot in the menu, and the tail that says what it is. */
function noteOf(s: { name: string; port: number | null; inStart: boolean; unresolved: string[] }): string {
  if (s.unresolved.length) return 'nothing named ' + s.unresolved.map((u) => '{{' + u + '}}').join(', ')
  if (alive.value.has(s.name)) return s.port ? ':' + s.port : 'running'
  // Said only when it is false, because it is the surprising half: a server
  // off `start:` is one the plain Start will not touch, and until it could be
  // named there was no way to run it at all.
  return s.inStart ? '' : 'not on Start'
}

/** One path for the bar and the row alike, so they cannot come to disagree
 *  about what starting a server means or what to say when it fails. */
async function toggleRuntime() {
  const ws = w.value
  if (ws) await toggleWorkspaceRuntime(ws, target.value)
}

async function openIde() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'ide' }))
}

async function openPreview() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'browser' }))
}

async function undo() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('git.undo', { workspaceId: ws.id }))
}
</script>

<template>
  <div v-if="w" class="verbs">
    <!-- Always: it is the switch, and it is what the window is open for.

         A plain button where there is nothing to pick — a detected `node`
         project, Herd, Compose all have one opaque "the servers" and no
         handle on any part of it, so a chevron there would open onto a list
         of one thing it already says. -->
    <button
      v-if="w.runtime && !pickable"
      class="btn ghost sw"
      :class="{ on: running }"
      :disabled="busy"
      :title="switchTitle"
      @click="toggleRuntime"
    >
      <component :is="running ? CircleStop : CirclePlay" />
      <span class="vl">{{ switchLabel }}</span>
    </button>

    <!-- §8 — and the split one wherever the servers have names.

         Left half: whatever it is pointed at, which is every server on
         `start:` until you pick one. Right half: each of them, with its own
         dot and its own switch — including the ones off `start:`, which had
         no way in at all before this. -->
    <div v-else-if="w.runtime" class="split" :class="{ off: busy }">
      <!-- `sw` is what drops the label first on a narrow column, and it is
           only right while the label is the word `Start`: its icon is a play
           triangle and nothing else on the bar is. Pointed at a named server
           the label is the name, and an unlabelled triangle would no longer
           say which one — so it keeps its word as long as the Run button
           beside it keeps its own. -->
      <button
        class="btn ghost run"
        :class="{ on: running, sw: !target }"
        :disabled="busy"
        :title="switchTitle"
        @click="toggleRuntime"
      >
        <component :is="running ? CircleStop : CirclePlay" />
        <span class="vl">{{ switchLabel }}</span>
      </button>
      <span class="div" />
      <OverflowMenu class="pick" label="Pick what this switch starts" :disabled="busy">
        <template #trigger><ChevronDown /></template>
        <!-- First, and separated: it is not one of the servers, it is all of
             them, and it is what the button does by default. -->
        <button @click="chooseServer(null)">
          <component :is="running && !target ? CircleStop : CirclePlay" />
          All servers
          <span v-if="!target" class="sc">on the button</span>
        </button>
        <span class="rule" />
        <button v-for="s in servers" :key="s.name" @click="chooseServer(s.name)">
          <i class="sd" :class="{ on: alive.has(s.name), bad: s.unresolved.length }" />
          {{ s.name }}
          <span v-if="noteOf(s)" class="sc">{{ noteOf(s) }}</span>
        </button>
        <span class="rule" />
        <!-- Its own half of the sheet. This menu is about servers, so the way
             out of it is about servers: the commands were a second list to
             scroll past on the way to the one thing that had been asked for. -->
        <button @click="openDeclarations(w.repoName, 'server')">
          <SlidersHorizontal /> Edit servers…
        </button>
      </OverflowMenu>
    </div>

    <!-- §8 — next to the switch, because they are the same kind of act: the
         things this checkout runs. It names the command rather than the
         category: `Run` was a word that opened a list, so the command pressed
         all afternoon cost two clicks and a read every time. Now the left half
         *is* that command and the chevron is the list — and picking from the
         list leaves the button on what you picked.

         Absent when this repository declares nothing, which is the whole of
         §3.9 applied to a control that used to answer for the repository next
         door: `listCommands` scopes the list, and an empty list is no button
         rather than a button onto somebody else's build. -->
    <div v-if="chosen" class="split" :class="{ off: busy }">
      <button class="btn ghost run" :disabled="busy" :title="runTitle" @click="askCommand(chosen)">
        <Terminal /><span class="vl">{{ label(chosen) }}</span>
      </button>
      <span class="div" />
      <OverflowMenu class="pick" label="Pick the command this button runs" :disabled="busy">
        <template #trigger><ChevronDown /></template>
        <button v-for="c in commands" :key="c.name" @click="chooseCommand(c)">
          <Terminal /> {{ label(c) }}
          <!-- Said only when it is not this repository's: a command under a
               repository that did not declare it is the project's, and that
               is a different folder. -->
          <span v-if="!c.repo" class="sc">project</span>
        </button>
        <span class="rule" />
        <!-- The list and the way to change it, in one place: the menu naming
             what exists is where anyone looks to add the next one. Commands
             only, for the same reason the Start menu offers servers only. -->
        <button @click="openDeclarations(w.repoName, 'command')">
          <SlidersHorizontal /> Edit commands…
        </button>
      </OverflowMenu>
    </div>

    <!-- Always, wherever there is a branch to push.
         Push is the one git verb that is never a surprise and never contextual
         — you reach for it because you decided to, not because the window
         noticed something. Hiding it until the app agreed there was something
         to send made it the only verb you had to go looking for, in a menu
         labelled "everything else". It is present either way — and inert when
         there is nothing to send, because a verb that is always live is one
         whose only answer half the time is a dialog saying "no".

         The tooltip is on the wrapper: a disabled button fires no mouse
         events, so a `title` on it is a reason nobody can read. -->
    <span v-if="git" class="verb" :title="pushTitle">
      <button
        class="btn ghost"
        :class="{ ready: canPush }"
        :disabled="busy || !canPush"
        @click="requestPlan(w.id, 'push')"
      >
        <ArrowUpFromLine /><span class="vl">Push</span>
        <span v-if="git.ahead" class="cnt">{{ git.ahead }}</span>
      </button>
    </span>
    <!-- Permanent, like Push and for the same reason: a verb reached for this
         often must not move, and a bar that changes shape as probes come back
         is one you cannot aim at without looking. -->
    <button
      v-if="git && canCatchUp"
      class="btn ghost"
      :class="{ nudge: behindBase > 0 }"
      :disabled="busy"
      :title="catchUpTitle"
      @click="requestPlan(w.id, 'rebase')"
    >
      <GitCompareArrows /><span class="vl">Catch up</span>
      <span v-if="behindBase" class="cnt">{{ behindBase }}</span>
    </button>
    <!-- §3.9 — beside Catch up, and only while there is something to pull.
         The other two verbs here are permanent on purpose: you reach for Push
         and Catch up because you decided to, so they must not move. Pull is not
         that kind of verb — nobody decides to pull, you pull *because*
         something arrived, and until it has there is nothing to aim at. So it
         is absent rather than inert, and its number is the whole of its
         reason for being on the bar. -->
    <button
      v-if="git && canPull"
      class="btn ghost nudge"
      :disabled="busy"
      :title="pullTitle"
      @click="requestPlan(w.id, 'pull')"
    >
      <ArrowDownToLine /><span class="vl">Pull</span>
      <span class="cnt">{{ git.behind }}</span>
    </button>

    <OverflowMenu label="Everything else you can do here" :disabled="busy">
      <button v-if="preview && preview.kind === 'url'" @click="openPreview">
        <AppWindow /> Open the preview
      </button>
      <button @click="openIde">
        <FileCode /> Open in the editor <span class="kb">O</span>
      </button>
      <template v-if="git">
        <span class="rule" />
        <button @click="undo">
          <Undo2 /> Undo to the last restore point
        </button>
      </template>
    </OverflowMenu>
  </div>
</template>

<style scoped>
.verbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
/* Carries the tooltip for the button inside it, which may be disabled and
   would then never be hovered at all. */
.verb { display: inline-flex; }
/* Sized for the column bar rather than for a 50px band: the same height as the
   instruments beside them, so the row reads as one strip of controls and not
   as verbs visiting from somewhere else. */
.verbs .btn {
  height: 26px;
  padding: 0 9px;
  font-size: var(--fs-xs);
  gap: 6px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.verbs .btn .lucide { width: 14px; height: 14px; }
/* The number that used to be the reason the button appeared at all. It now
   rides on a button that is always there, so it carries the signal instead. */
.verbs .cnt {
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs);
  color: var(--ok);
}
.verbs .nudge .cnt { color: var(--warn); }

/* Behind its base is the one state where rebasing is the next thing to do,
   and committed-and-ahead is the one where pushing is. Same two colours the
   list's counters use for the same two facts. */
.nudge { color: var(--warn); }
.ready { color: var(--ok); }
.verbs .btn.on { color: var(--ok); }

/* ── the split Run (§8) ──────────────────────────────────────────────
 *
 * One control, two halves: *the command* and *which command*. The border is
 * what makes them read as one thing — every other verb on this bar is ghost
 * until hovered, and two transparent halves with a hairline floating between
 * them read as two buttons that happen to be adjacent.
 *
 * No `overflow: hidden` to clip the halves to the corners, tempting as it is:
 * the chevron's menu is absolutely positioned inside this box, and clipping
 * the box clips the menu to a 26px strip. The halves round their own outer
 * corners instead. */
.split {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.split:hover { border-color: var(--line-strong); }
/* One border for one control.
 *
 * `.btn:hover` in base.css raises `border-color` to `--line-strong`, and
 * `.btn.ghost:hover` — more specific — overrides only the background and the
 * colour, so every ghost button reveals a border when hovered. That is right
 * for a button standing on its own and wrong for a half of something: the
 * shape around these two already draws the border, so the half drew a second
 * one inside it and the pair read as a button inside a button. */
.verbs .split :deep(.btn:hover:not(:disabled)) { border-color: transparent; }
/* The whole control goes quiet together while a plan holds the repository —
   each half is disabled in its own right, but the border is the shape's. */
.split.off { opacity: 0.4; }
.split.off:hover { border-color: var(--line); }
/* The halves: 24px inside a 26px box, and the outer corners follow the border
   they sit against — 6px, which is the box's 7px less the 1px of border it
   sits behind, so the hover fill does not square the corners off or float
   inside them. Through
   `:deep`, because the chevron's button belongs to OverflowMenu and carries
   its scope, not this one — which is also why the Run trigger has been 32px
   tall beside a 26px Push since the day it was added. */
.verbs .split :deep(.btn) {
  height: 24px;
  border-radius: 0;
}
.verbs .split .btn.run { padding: 0 9px; border-radius: 6px 0 0 6px; }
/* Disabled twice over: `.off` already dims the shape, so the halves must not
   dim again inside it or the pair reads as a third state. */
.split.off :deep(.btn:disabled) { opacity: 1; }
/* The hairline between them, drawn short so it parts the halves without
   reaching the border and making a cross of it. */
.split .div { flex: none; width: 1px; height: 14px; background: var(--line); }
/* The chevron is the narrowest thing on the bar that is still a target: it
   says "there are others" and nothing else, so it gets no word and no room
   for one. */
.verbs .split :deep(.pick .btn) { padding: 0 5px; border-radius: 0 6px 6px 0; }
.verbs .split :deep(.pick .lucide) { width: 13px; height: 13px; }
/* A server's state in the menu, the same dot the bar uses for the workspace:
   filled when something is answering to that name, hollow when nothing is,
   and warned when the line still holds a placeholder and would refuse. It
   takes the icon slot, so it lines up with the icons on the rows around it. */
.sd {
  flex: none;
  width: var(--ic-sm);
  height: var(--ic-sm);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--text-dim);
  transform: scale(0.5);
}
.sd.on { background: var(--ok); box-shadow: none; }
.sd.bad { background: var(--warn); box-shadow: none; }

/* Where a project-level command runs, at the right edge of its own row. The
   menu's `.kb` slot is the same shape, and is the keystroke's — a word that is
   not one has no business borrowing it. */
.sc {
  margin-left: auto;
  padding-left: 14px;
  font-size: 11px;
  color: var(--text-dim);
}

/* Narrow column: the promoted verbs keep their labels — they are one or two,
   and a word is the whole reason they were promoted. The label the bar drops
   first is Start's, because its icon is a play triangle and nothing else here
   is. The command's name is the last to go, and it goes only because a name
   is a name: at this width there is nothing left to give. */
@container (max-width: 620px) {
  .verbs .btn.sw .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
@container (max-width: 520px) {
  .verbs .split .btn.run .vl { display: none; }
  .verbs .split .btn.run { padding: 0 6px; }
}
</style>
