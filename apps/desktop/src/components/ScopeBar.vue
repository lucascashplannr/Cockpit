<script setup lang="ts">
import { computed } from 'vue'
import { GitBranch, Layers, ShieldCheck } from '@lucide/vue'
import BranchMenu from './BranchMenu.vue'
import LockChip from './LockChip.vue'
import TopicActions from './TopicActions.vue'
import ViewSwitcher from './ViewSwitcher.vue'
import WorkspaceActions from './WorkspaceActions.vue'
import {
  activeAgentScope, activeWorkspace, isBranchProtected, onProject, projectNarrowing, projectScopeWorkspaces, scopeLabel,
  selectedTopicGroup,
} from '../core/store.js'

/**
 * §12 — one bar across the top of the window, for the thing you are standing
 * on: what it is, how it stands, and the verbs that act on it.
 *
 * It was the conversation column's own header, which was right while the
 * conversation was the only thing that could be on the right of the window.
 * With the review able to take the whole width (§12's ladder), that put the
 * repository's name, its branch, Push, Catch up, Start and Open in IDE inside
 * a column that is not always there — so reading a diff full-width meant a
 * window with no name on it and no way to push what you had just read.
 *
 * None of that was ever about the conversation. It is about the checkout, and
 * the checkout does not change when you change what you are looking at, so the
 * bar does not either: it spans both columns and survives every view. What
 * belongs to a *tool* stays with the tool — the review's own strip is below
 * this, inside its column.
 */

const w = computed(() => activeWorkspace.value)

/**
 * §4 — what this line is speaking for.
 *
 * On a topic that is every branch under it, not the one that happens to be the
 * anchor. The bar used to read the anchor's git state whatever the scope was,
 * so standing on a topic showed one of its branches by name and that branch's
 * counts — a true statement about something nobody had asked about, sitting
 * where the answer to "how does this topic stand" belongs.
 */
const covered = computed(() => {
  // §7 — the project: every repository, at its main checkout.
  if (onProject.value) return projectScopeWorkspaces.value
  return selectedTopicGroup.value?.workspaces ?? (w.value ? [w.value] : [])
})

/**
 * The branch is named only when there is exactly one of it. Across a topic
 * there is no single branch to name, and picking one would be arbitrary.
 *
 * Ahead and behind used to be summed here too, and drawn as an ↑/↓ pair in the
 * run below. They are gone from this line — not from the bar. The same two
 * numbers ride on Push and on Catch up, three inches to the right, on the very
 * buttons that act on them; printing them twice on one 52px row made the bar
 * read as crowded while saying nothing it had not already said. A count next
 * to its verb is worth more than a count next to a glyph.
 */
const git = computed(() => {
  const ws = covered.value.filter((x) => x.git)
  if (!ws.length) return null
  return { branch: ws.length === 1 ? (ws[0]!.git!.branch ?? 'detached') : null }
})

/**
 * Named only when there is one to name, and not when it is already the word
 * beside it.
 */
const branchName = computed(() =>
  git.value?.branch && git.value.branch !== label.value.name ? git.value.branch : null,
)

/**
 * §16 — the branch named here is protected in its repository.
 *
 * Drawn as the branch chip's own glyph rather than as a mark of its own. There
 * used to be a shield in the run of counters, and it meant something else —
 * "this is the default branch, so an agent's first write captures a restore
 * point" — which is true of every repository on its default branch and was
 * read by nobody as that. A shield now means one thing, the handrail you put
 * up, and it sits on the word it is about.
 */
const guarded = computed(
  () =>
    !!branchName.value &&
    // On the project the branch named is the one repository it was narrowed
    // to, which need not be the row the panel happens to be anchored on.
    isBranchProtected(onProject.value ? (covered.value[0] ?? w.value) : w.value, branchName.value),
)

/* §7 — the project, narrowed to some of its repositories: picked by ⌘-click
 * in the list or from the composer, and counted here because it is what the
 * word to the left now stands for. */
const narrowing = computed(() => projectNarrowing.value)
const coveredNames = computed(() => covered.value.map((x) => x.name).join(', '))

/* ── what the bar is speaking for ─────────────────────────────────────────
 *
 * This and the branch line above it lived on two bars, one over the other, so
 * the column opened with two rows of chrome before the first word of the work:
 * one saying where the branch stood, one saying what the agent was pointed at.
 * They are the same sentence — *this is what you are on* — split across two
 * lines, and the split cost thirty-eight pixels of every screen.
 */
const scope = computed(() => activeAgentScope.value)
/**
 * A repository checked out for a topic says so here: on the strip its tile
 * sits inside the topic's frame, and the bar should not have a lesser idea of
 * where you are than the list does.
 */
const label = computed(() => {
  const l = scopeLabel(scope.value)
  return scope.value?.kind === 'workspace' && l.kind === 'Repo' && w.value?.topicId
    ? { ...l, kind: 'Topic repo' }
    : l
})
/**
 * A repository with no git remote says so in its own kicker: it is why this
 * bar has no Push and never will, said once, in the word that already says
 * what kind of thing this is.
 */
const offline = computed(() => scope.value?.kind === 'workspace' && w.value?.git?.hasRemote === false)

/* §8 — the servers are not on this line. They were a dot and a port here, a
 * fact beside a switch that already said the same thing in green, three inches
 * to the right. The switch now carries the one dot, and the port became the
 * button that opens it (WorkspaceActions, TopicActions). */

</script>

<template>
  <header v-if="w" class="head">
    <!-- What this is, and where it stands: one line, in reading order.
         It was stacked for a while, which put two type sizes on top of
         each other in a 52px bar and read as cramped whatever the gap was.
         The reason it was stacked — a branch name is a ticket title with
         hyphens in it and ate the whole row — is answered here by letting
         the branch, and only the branch, ellipsis. -->
    <span class="scope">
      <span class="idr" :title="offline ? label.name + ' — no git remote: nothing to push to or pull from' : label.name">
        <span class="k">{{ offline ? 'Off. ' + label.kind : label.kind }}</span>
        <span class="n">{{ label.name }}</span>
      </span>

      <!-- §2 — and the one control that moves this checkout. Named only
           when there is one to name, and not when it is already the name
           beside it: on a branch the two are the same word. Across a topic
           there is no single branch at all.

           Pressable only outside a topic, which is the case it was built
           for: "I work on dev and merge to main" is one checkout moving
           between two branches that already exist. Inside a topic the
           branch is not a choice — it *is* the topic, one per repository,
           in a folder the topic owns — so offering a switch there offers to
           take the checkout out of the thing it belongs to. The name stays,
           because "which branch is this" is still a fair question; only the
           invitation goes. -->
      <BranchMenu
        v-if="branchName && !w.topicId && !onProject"
        class="br"
        :workspace-id="w.id"
        :branch="branchName"
      />
      <span
        v-else-if="branchName"
        class="br brf"
        :class="{ guarded }"
        :title="'On ' + branchName + (onProject ? '' : ' — this topic’s branch') + (guarded ? ', protected' : '')"
      >
        <component :is="guarded ? ShieldCheck : GitBranch" class="sm" /><span class="bn">{{ branchName }}</span>
      </span>
    </span>

    <!-- §7 — an agent's claim on what is named to the left. Outside the dim
         run below, though it was the last word of it: that run clips, and a
         popover cannot hang from inside a box that clips. -->
    <LockChip :workspaces="covered" />

    <!-- Everything that is merely true, in one dim run that clips rather
         than wraps: the bar keeps its line whatever the window does, and
         what falls off the end is by construction the least of it. Each
         one that can be acted on opens the tool that says more. -->
    <span class="stats">
      <!-- How many repositories the word to the left stands for. -->
      <span
        v-if="narrowing?.narrowed"
        class="stat num"
        :title="'Narrowed to ' + coveredNames + ' — ' + (narrowing.every.length - covered.length) + ' left out'"
      >
        <Layers class="sm si" />
        <span class="v">{{ covered.length }} of {{ narrowing.every.length }}</span>
      </span>
      <span
        v-else-if="covered.length > 1"
        class="stat num"
        :title="covered.length + ' repositories in this scope'"
      >
        <Layers class="sm si" />
        <span class="v">{{ covered.length }}</span>
      </span>

      <!-- No uncommitted-changes count here: the row in the list carries
           it, beside ahead and behind, under the same glyph it had here. -->

      <!-- §8 — a non-portable runtime says so, rather than failing later. -->
      <span
        v-if="w.runtime && !w.runtime.portable"
        class="stat quiet"
        title="These servers are set up on this machine only — they do not follow the repository"
      >
        local only
      </span>
    </span>

    <!-- The only thing here that wants to be wide. It used to be `.stats`
         doing this job as well as its own, which is what made the counters
         the first thing to go. -->
    <span class="grow" />

    <!-- What you can do, pinned right and never clipped: the verbs of the
         thing named at the far left, and then the one control that is about
         the window instead. The conversation's own two used to sit between
         them in a case of their own — the memory is a review tool now, and
         the earlier threads hang from the conversation itself. Each of them
         went to the thing it is about; this bar is about the checkout. -->
    <span class="acts">
      <TopicActions v-if="selectedTopicGroup" :group="selectedTopicGroup" />
      <!-- On the project there is no one checkout to start, push or open:
           the verbs are a repository's, and a row is one click away. -->
      <WorkspaceActions v-else-if="!onProject" />

      <!-- §12 — how the right of the window is divided. It ends the bar
           because it is the only control here that is about the *window*
           rather than about the thing the window is showing. -->
      <ViewSwitcher />
    </span>
  </header>
</template>

<style scoped>
/* ── header ──────────────────────────────────────────────────────────── */
/* Quiet, and ranked. Everything in the middle is a fact *about* the work
   rather than the work, so it is all one small size in one dim colour; the
   only thing at full contrast is the name the whole line is about, and the
   only things with a shape of their own are the ones you can press. */
/* Also the window's handle. The band that used to be the drag region is gone,
   and a frameless window nobody can move is worse than a band nobody needs —
   so this bar carries it, and every control in it opts back out. */
.head {
  container-type: inline-size;
  -webkit-app-region: drag;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Fixed, and no wrapping. This row carries the name, the state, the verbs
     and the instruments; allowed to wrap it grew a second line of chrome on
     every window narrow enough to matter, which is most of them once the
     review column is open. The state clips instead (`.stats`), and the acts
     are never in the running to be clipped. 52px is where the workspace
     list's own header ends, so the two columns start their content on one
     line. */
  height: 52px;
  padding: 0 10px 0 18px;
  min-width: 0;
  /* The bar belongs to no column, so it has a role of its own (tokens.css,
     "surfaces by role"). */
  background: var(--surface-bar);
  border-bottom: 1px solid var(--line);
}


/* The order things give up their width, and it is deliberate.
 *
 * Flex shrinks every willing item at once, weighted by `shrink × basis`, so the
 * weights below are a ranking rather than a sequence: at 200 : 5 : 1 the branch
 * has given two hundred pixels before the name gives five and the counters give
 * one. In practice it reads as three stages — the branch ellipsises down to a
 * stub, then the repository's name starts to lose characters, and only with
 * nothing left anywhere do the counters begin to clip.
 *
 * The counters were going first, because `.stats` was `flex: 1 1 0`: with no
 * basis of its own to defend it was both the thing that absorbed the free space
 * and the first thing to hand it back. A `.grow` spacer does that job now, and
 * the counters are the numbers you actually act on. */
.stats {
  flex: 0 1 auto;
  /* Last resort, and only that.
   *
   * The weights inside `.scope` rank the branch against the name, but the top
   * level splits the deficit between `.scope` and this box first — and there,
   * at 1 : 1, `shrink × basis` made it roughly four to one, so a counter was
   * being cut off while the branch still had eighty pixels to give. A factor
   * this small takes a fraction of a pixel per hundred: the counters hold
   * until `.scope` has frozen against its own floor (the `flex: none` kicker
   * and the chip's icon, chevron and padding), and only the deficit left after
   * that reaches them. Not zero, because zero would push the verbs off the
   * right edge instead of clipping a number. */
  flex-shrink: 0.01;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}
.stats > * { flex: none; }

/* The only thing on the row that wants to be wide. */
.grow { flex: 1 1 0; min-width: 0; }

/* The right zone: the verbs, then the view control. Never shrinks. */
.acts { flex: none; display: flex; align-items: center; gap: 8px; }

/* What the line is about — and, inside it, the two halves in the order they
   are given up. */
.scope { flex: 0 1 auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Second to give, and only after the branch beside it has nothing left. */
.idr { flex: 0 5 auto; display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
/* First to give, by two hundred to one. A branch name is a ticket title with
   hyphens in it — the longest thing on this row and the least of it, and the
   only one of the three that is named again somewhere else the moment you look
   (its own hover, and the menu it opens).
 *
 * No floor, deliberately. `min-width` is a floor at *all* times and not only
 * while shrinking, so 66px of it padded every short branch — `main`, or the
 * one-character one this was caught on — out to a box half again its size, on
 * every screen, to buy legibility in a window nobody has open. What holds the
 * chip up instead is its own furniture: the icon, the chevron and the padding
 * are all `flex: none`, so it cannot collapse to nothing. */
.br { flex: 0 200 auto; min-width: 44px; max-width: 26ch; }
/* The branch as a fact: the chip's shape and colour, minus the invitation —
   no chevron, no hover, no press. Same box, so the row does not move when the
   same repository is looked at from inside a topic and from outside one. */
.brf {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 5px;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.brf .lucide { flex: none; width: 12px; height: 12px; opacity: 0.85; }
.brf .bn { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brf.guarded .lucide { color: var(--text-muted); opacity: 1; }

/* Baseline, not centre. Centred, the 10px kicker floats a couple of pixels
   above the line the name sits on and the pair reads as two things that missed
   each other. It costs nothing here: the small word needs less room above and
   below its own baseline than the big one does, so aligning them leaves the box
   exactly as tall as the name and the whole group stays centred in the bar. */
/* And after the branch, this: "REPOSITORY" is a category, not an identity, and
   it is the one thing here that can go without the row losing an answer. It
   gives fifty times faster than the name it labels, so on a column narrow
   enough to force the choice the name is what survives. */
.scope .k {
  flex: 0 50 auto;
  min-width: 0;
  overflow: hidden;
  line-height: 1;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.scope .n {
  line-height: 1;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* No pill, no fill. A stat is a word and a number. */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  line-height: 1;
  color: var(--text-dim);
  min-width: 0;
}
.stat.quiet { color: var(--text-dim); opacity: 0.75; }
.si { color: var(--text-dim); opacity: 0.8; }
.stat .k { color: var(--text-dim); }
.stat .v {
  color: var(--text-muted);
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head button,
.head :deep(button),
.head .scope { -webkit-app-region: no-drag; }

</style>
