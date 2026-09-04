<script setup lang="ts">
import { computed } from 'vue'
import {
  BookMarked, FileDiff, GitBranch, History, Layers, MousePointerClick, PanelRight, ShieldCheck,
} from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import ConflictPanel from './ConflictPanel.vue'
import ConversationDrawer from './ConversationDrawer.vue'
import BranchMenu from './BranchMenu.vue'
import Wordmark from './brand/Wordmark.vue'
import TopicActions from './TopicActions.vue'
import WorkspaceActions from './WorkspaceActions.vue'
import {
  activeAgentScope, activeWorkspace, attentionOf, goTo, scopeLabel, selectedTopicGroup,
  sessionsForScope, state,
} from '../core/store.js'

/**
 * The third column, and the four roles in the order they are used (§12,
 * rewritten):
 *
 *   1. navigate — the rail and the list to the left, and the scope bar the
 *                 Agent carries: project, topic, repository, branch.
 *   2. agent    — this column. Permanently. It is what the window is for.
 *   3. review   — Diff / Code / Journal / Terminal, in a fourth column that
 *                 opens on demand and is closed by default.
 *   4. run      — the runtime verbs, in the title band above.
 *
 * They used to be six peer tabs, which said all four were the same kind of
 * thing. They are not: one of them is the act and the rest are its instruments.
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
const covered = computed(() =>
  selectedTopicGroup.value?.workspaces ?? (w.value ? [w.value] : []),
)

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
 * §4 — which repositories under this scope sit on their own default branch.
 *
 * This was a full-width banner over the conversation — an unchanging sentence,
 * on screen for the whole of every thread, costing a row of the work to say
 * something reassuring. It is a fact about where you are standing, so it lives
 * on the line that says where you are standing, at the weight of the other
 * facts there: a glyph, and the sentence on hover.
 */
const onDefault = computed(() =>
  covered.value.filter((x) => x.git && x.git.branch && x.git.branch === x.git.base),
)
const onDefaultTitle = computed(() => {
  const names = onDefault.value.map((x) => x.name)
  return (
    names.join(', ') +
    (names.length > 1 ? ' are on their default branch' : ' is on its default branch') +
    ' — a restore point is captured before the agent’s first write.'
  )
})

const changed = computed(() =>
  covered.value.reduce((n, x) => {
    const g = x.git
    return n + (g ? g.staged + g.unstaged + g.untracked : 0)
  }, 0),
)

/* ── what the conversation is on, and its two instruments ─────────────────
 *
 * These lived on a second bar of their own, directly under this one, so the
 * column opened with two rows of chrome before the first word of the work:
 * one saying where the branch stood, one saying what the agent was pointed at.
 * They are the same sentence — *this is what you are on* — split across two
 * lines, and the split cost thirty-eight pixels of every screen.
 */
const scope = computed(() => activeAgentScope.value)
const label = computed(() => scopeLabel(scope.value))
const conversations = computed(() => sessionsForScope(scope.value))
const waiting = computed(
  () => conversations.value.filter((c) => attentionOf(c) !== 'none').length,
)

/**
 * §8 — the servers, as one fact and one way in.
 *
 * They were three things on this line: a status dot, the name of the runner
 * ("node"), and a pill per bound port. Two of the three were noise wherever
 * you stood — the runner's name is in the Servers tool and never changes, and
 * a port pill beside the word `down` advertises an address nothing is
 * listening on, which is how this bar came to read `node down · web :8611`.
 *
 * So: the ports while they are actually bound, the status while they are not,
 * and the whole of it opens the tool that holds the rest.
 */
const servers = computed(() => {
  const rt = w.value?.runtime
  if (!rt) return null
  const ports = rt.ports ?? []
  const bound = rt.status === 'up' && ports.length > 0
  return {
    word: bound ? ports.map((p) => ':' + p.port).join(' ') : rt.status,
    title:
      rt.impl +
      ' · servers ' +
      rt.status +
      (ports.length ? ' · ' + ports.map((p) => p.name + ' :' + p.port).join(', ') : '') +
      ' — open the Servers tool',
  }
})

</script>

<template>
  <section class="panel">
    <!-- Nothing selected is still a first impression: the app says its name. -->
    <div v-if="!w" class="welcome">
      <Wordmark :height="27" class="wm" />
      <p class="tag">Everything in flight, in one window.</p>
      <div class="hints">
        <span class="hint">
          <span class="kbd">⌘K</span> jump to a repository or branch, or run anything
        </span>
        <span class="hint"><MousePointerClick class="sm" /> or pick one on the left</span>
      </div>
    </div>

    <template v-else>
      <!-- One line, and it stays one line. Three zones, ranked: what this
           is, what is merely true about it, and what you can do to it. It was
           a single wrapping run of thirteen controls at one weight, which on
           any real window meant two rows of chrome before the first word of
           the work and an eye with nothing to sort them by. -->
      <header class="head">
        <!-- What this is, and where it stands: one line, in reading order.
             It was stacked for a while, which put two type sizes on top of
             each other in a 52px bar and read as cramped whatever the gap was.
             The reason it was stacked — a branch name is a ticket title with
             hyphens in it and ate the whole row — is answered here by letting
             the branch, and only the branch, ellipsis. -->
        <span class="scope">
          <span class="idr" :title="label.name">
            <span class="k">{{ label.kind }}</span>
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
            v-if="branchName && !w.topicId"
            class="br"
            :workspace-id="w.id"
            :branch="branchName"
          />
          <span v-else-if="branchName" class="br brf" :title="'On ' + branchName + ' — this topic’s branch'">
            <GitBranch class="sm" /><span class="bn">{{ branchName }}</span>
          </span>
        </span>

        <span class="rule" />

        <!-- Everything that is merely true, in one dim run that clips rather
             than wraps: the bar keeps its line whatever the window does, and
             what falls off the end is by construction the least of it. Each
             one that can be acted on opens the tool that says more. -->
        <span class="stats">
          <!-- §4 — allowed, and the reason a restore point is captured before
               anything is written. Wordless: it is reassurance, not a thing to
               act on, and the composer says it in words where it matters. -->
          <span v-if="onDefault.length" class="stat" :title="onDefaultTitle">
            <ShieldCheck class="sm si" />
          </span>

          <!-- How many repositories the word to the left stands for. -->
          <span
            v-if="covered.length > 1"
            class="stat num"
            :title="covered.length + ' repositories in this scope'"
          >
            <Layers class="sm si" />
            <span class="v">{{ covered.length }}</span>
          </span>

          <!-- The count is the way into the review layer: what changed is the
               reason you would open it at all. It is the one number here with
               no verb of its own to ride on — ahead and behind have Push and
               Catch up, and were dropped from this run for it. -->
          <template v-if="git">
            <button
              class="stat num act"
              :title="changed + ' uncommitted change(s) — open the diff'"
              @click="goTo('diff')"
            >
              <FileDiff class="sm si" />
              <span class="v" :class="{ warn: changed }">{{ changed }}</span>
            </button>
          </template>

          <button
            v-if="servers"
            class="stat act"
            :title="servers.title"
            @click="goTo('servers')"
          >
            <i class="dot" :class="w.runtime!.status" />
            <span class="v">{{ servers.word }}</span>
          </button>

          <!-- §8 — a non-portable runtime says so, rather than failing later. -->
          <span
            v-if="w.runtime && !w.runtime.portable"
            class="stat quiet"
            title="These servers are set up on this machine only — they do not follow the repository"
          >
            local only
          </span>

          <span v-if="w.lease" class="stat warn" :title="w.lease.reason">locked</span>
        </span>

        <!-- The only thing here that wants to be wide. It used to be `.stats`
             doing this job as well as its own, which is what made the counters
             the first thing to go. -->
        <span class="grow" />

        <!-- What you can do, pinned right and never clipped. The verbs of the
             thing named at the far left, then the conversation's own
             instruments — kept apart, and shaped apart, because a Push and a
             "show me the earlier conversations" are not the same kind of act
             and drawing them as one row of identical ghosts said they were. -->
        <span class="acts">
          <TopicActions v-if="selectedTopicGroup" :group="selectedTopicGroup" />
          <WorkspaceActions v-else />

          <span class="inst">
            <!-- §6 — the conversation's own two, and the way into the review
                 layer. They belong beside what they are about, which is the
                 scope named at the far left of this same line. -->
            <button
              :class="{ on: state.historyOpen, waiting: waiting > 0 }"
              title="Earlier conversations here"
              @click="state.historyOpen = !state.historyOpen"
            >
              <History class="sm" />
              <span v-if="conversations.length" class="n">{{ conversations.length }}</span>
            </button>
            <button
              :class="{ on: state.memoryOpen }"
              title="The durable memory this conversation reads on the way in"
              @click="state.memoryOpen = !state.memoryOpen"
            >
              <BookMarked class="sm" />
              <span v-if="w.hasMemory" class="pip" />
            </button>
            <button
              :class="{ on: state.reviewOpen }"
              :title="(state.reviewOpen ? 'Close' : 'Open') + ' the review — diff, code, journal, terminal'"
              @click="state.reviewOpen = !state.reviewOpen"
            >
              <PanelRight class="sm" />
            </button>
          </span>
        </span>
      </header>

      <!-- §3.7 — above everything on purpose: while a rebase is stopped, none
           of what is below is the next thing to do. Absent otherwise (§3.9). -->
      <ConflictPanel />

      <div class="body">
        <AgentTab :workspace="w" />

        <!-- §6 — hung from the bar it is opened from, and over the thread
             rather than instead of it. In here, not beside `AgentTab`, so it
             is clipped to the conversation's own box: a drawer that can spill
             past the column it belongs to is a panel with an animation. -->
        <ConversationDrawer v-if="state.historyOpen" />
      </div>
    </template>
  </section>
</template>

<style scoped>
/* The verbs drop their labels when this column gets narrow, and it is this
   box — not the window — that knows how narrow it is: the conversation gives
   up its width to the review column while the window stays exactly as wide. */
.panel {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
}

/* ── welcome ─────────────────────────────────────────────────────────── */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px;
}
.wm {
  color: var(--brand-ink);
  --wm-lead: var(--accent);
}
.tag {
  margin: -4px 0 0;
  font-size: var(--fs-md);
  color: var(--text-dim);
}
.hints {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

/* ── header ──────────────────────────────────────────────────────────── */
/* Quiet, and ranked. Everything in the middle is a fact *about* the work
   rather than the work, so it is all one small size in one dim colour; the
   only thing at full contrast is the name the whole line is about, and the
   only things with a shape of their own are the ones you can press. */
/* Also the window's handle. The band that used to be the drag region is gone,
   and a frameless window nobody can move is worse than a band nobody needs —
   so this bar carries it, and every control in it opts back out. */
.head {
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
  /* Its own surface. On `--bg` it was the same colour as the conversation
     under it and only a hairline said otherwise; on the raised white it reads
     as the thing the column is headed by. */
  background: var(--panel-raised);
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

/* The right zone: verbs, then instruments. Never shrinks. */
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
/* A hairline instead of a gap: it parts the name from the numbers without
   adding another shape to the row. */
.rule { flex: none; width: 1px; height: 14px; background: var(--line); }

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
.stat.warn { color: var(--warn); }
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
.stat .v.warn { color: var(--warn); }
/* The changed count is a button, because it is the reason you would open the
   review layer at all: what moved is what there is to read. */
.stat.act { padding: 0 6px; }
.stat.act:hover { background: var(--hover); color: var(--text); }

.head button,
.head :deep(button),
.head .scope { -webkit-app-region: no-drag; }

/* The three instruments, in a case of their own.
 *
 * They were three more ghost icons in the same run as the verbs, at the same
 * size and the same weight — so a Push and a "show me the earlier
 * conversations" were the same shape, and the only way to tell a bar of eight
 * of them apart was to hover all eight. What they have in common is that none
 * of them *does* anything: each one opens or closes a way of looking. The case
 * is that sentence, drawn. */
.inst {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  border: 1px solid var(--line-soft);
}
.inst > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.inst > button:hover { color: var(--text); background: var(--hover); }
.inst > button.on { background: var(--panel-raised); color: var(--accent); box-shadow: var(--shadow-xs); }
.inst > button.waiting { color: var(--warn); }
.inst .n { color: inherit; }
.inst .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--agent); }

/* Positioned, because the conversation drawer hangs inside it — from the top
   of this box, which is exactly the underside of the bar. */
.body { position: relative; flex: 1; min-height: 0; overflow: hidden; }
</style>
