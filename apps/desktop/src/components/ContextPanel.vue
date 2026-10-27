<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { CircleStop, Columns2, History, MousePointerClick, Plus, X } from '@lucide/vue'
import type { Conversation } from '@cockpit/shared'
import AgentTab from './tabs/AgentTab.vue'
import ConversationDrawer from './ConversationDrawer.vue'
import Wordmark from './brand/Wordmark.vue'
import {
  activeAgentScope, activeWorkspace, attentionOf, closeFresh, hasMail, hasNewTab, closeSplit, closeTab, isBusy, isLive,
  openThreadFor, pairTabs, pickThread, renameConversation, reorderTabs, tabEntriesFor, type TabEntry, sessionsForScope, splitFor, startFresh, state, stopConversation,
  stripFor,
} from '../core/store.js'

/**
 * The conversation, and nothing else.
 *
 * It used to be the whole right-hand column — the scope bar, the conflict
 * strip, the thread and the drawer over it — because for a while the
 * conversation *was* the right-hand column. Now the review can have the same
 * width (§12's ladder), and everything that was true whichever of the two you
 * were looking at moved up a level to the shell: the bar (ScopeBar), the
 * conflict strip, and the list of earlier threads that hangs from the bar.
 *
 * What is left is the one thing that is genuinely this column's: the thread,
 * and the welcome that stands in for it when nothing is selected.
 */

const w = computed(() => activeWorkspace.value)

/**
 * §6 — every conversation that has been had on this scope, and whether any of
 * them is waiting on you.
 *
 * The button was in the window's bar, beside the memory, in a case labelled
 * "the conversation's instruments". Neither of them belonged there: one bar
 * for the checkout had grown two controls that are not about the checkout at
 * all. The memory went to the review column, where the other documents you
 * read are; this is the list of *these* threads, so it belongs to the thread —
 * at the top right of it, which is also where its drawer already hung.
 */
const conversations = computed(() => sessionsForScope(activeAgentScope.value))
const waiting = computed(
  () => conversations.value.filter((c) => attentionOf(c) !== 'none').length,
)

/** The conversation that has the composer. */
const thread = computed(() => openThreadFor(activeAgentScope.value))

/**
 * §6 — the engine, let go, beside the history at the end of the tab bar.
 *
 * It was the last thing in the conversation's bar (AgentTab), which is where it
 * had always been; nothing about what it does has changed. A conversation that
 * is not holding a process has nothing to let go of, so the button is simply
 * absent — and the two either side of it close up.
 */
async function stop(): Promise<void> {
  if (thread.value) await stopConversation(thread.value.id)
}

/* ── §7 — the tab bar, and two threads side by side ─────────────────────
 *
 * Always there, even for one conversation: it is the way between them, and a
 * way that appears only once there are two is one nobody learns. An empty
 * composer is a tab of its own, so the bar is never empty and never lies
 * about what is on screen.
 */
const strip = computed(() => stripFor(activeAgentScope.value))
const pair = computed(() => splitFor(activeAgentScope.value))

function closeOne(c: Conversation): void {
  const s = activeAgentScope.value
  if (s) closeTab(s, c.id)
}
function closeNew(): void {
  const s = activeAgentScope.value
  if (s) closeFresh(s)
}

/** Double-click a tab to name it — the bar under it is gone in a single pane. */
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const renameEl = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function startRename(c: Conversation): void {
  renaming.value = c.id
  renameDraft.value = c.title
  void nextTick(() => {
    const el = Array.isArray(renameEl.value) ? renameEl.value[0] : renameEl.value
    el?.focus()
    el?.select()
  })
}
function commitRename(c: Conversation): void {
  if (renaming.value !== c.id) return
  renaming.value = null
  const name = renameDraft.value.replace(/\s+/g, ' ').trim()
  if (name && name !== c.title) void renameConversation(c.id, name)
}

function dotOf(c: Conversation): string {
  if (attentionOf(c) !== 'none') return 'you'
  if (isBusy(c)) return 'work'
  if (hasMail(c)) return 'mail'
  return isLive(c) ? 'open' : 'done'
}
/** A dot only when there is news: working, needs you, or a message waiting. */
function news(c: Conversation): boolean {
  const d = dotOf(c)
  return d === 'work' || d === 'you' || d === 'mail'
}
function stateWord(c: Conversation): string {
  const d = dotOf(c)
  return d === 'you' ? 'needs you' : d === 'work' ? 'working' : d === 'mail' ? 'a message is waiting' : d === 'open' ? 'open' : 'finished'
}
function press(c: Conversation, e: MouseEvent): void {
  // The click a drag ends on is the end of the drag, not a choice of tab.
  if (dragEnded) return
  const s = activeAgentScope.value
  if (s) pickThread(s, c.id, e.metaKey || e.ctrlKey)
}

/* ── §7 — tabs grabbed: moved along the bar, or dropped on one to pair ───
 *
 * Pointer events rather than HTML drag and drop: the tab itself follows the
 * cursor, with no ghost image, and the bar is the only place it can land.
 * Over the middle half of a single tab, a single tab pairs with it (the
 * grabbed one on the right); anywhere else it goes before or after.
 */
const entries = computed(() => tabEntriesFor(activeAgentScope.value))
const isOn = (e: TabEntry) =>
  e.kind === 'one' ? e.conv.id === thread.value?.id : e.convs.some((c) => c.id === thread.value?.id)

const navEl = ref<HTMLElement | null>(null)
const drag = reactive({
  key: null as string | null,
  moved: false,
  dx: 0,
  target: null as string | null,
  mode: null as 'before' | 'after' | 'pair' | null,
  caret: 0,
})
let startX = 0
let rects: { key: string; kind: string; left: number; right: number }[] = []
let dragEnded = false

function measure(): void {
  const nav = navEl.value
  if (!nav) return
  rects = [...nav.querySelectorAll<HTMLElement>('[data-tab]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { key: el.dataset.tab!, kind: el.dataset.kind!, left: r.left, right: r.right }
  })
}

function down(ev: PointerEvent, e: TabEntry): void {
  if (ev.button !== 0 || renaming.value) return
  if ((ev.target as HTMLElement).closest('.px, input')) return
  startX = ev.clientX
  drag.key = e.key
  drag.moved = false
  drag.dx = 0
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function move(ev: PointerEvent): void {
  const dx = ev.clientX - startX
  if (!drag.moved) {
    if (Math.abs(dx) < 4) return
    drag.moved = true
    measure()
  }
  drag.dx = dx
  const me = rects.find((r) => r.key === drag.key)
  const others = rects.filter((r) => r.key !== drag.key)
  const x = ev.clientX
  let target: (typeof rects)[number] | undefined
  let mode: typeof drag.mode = null
  for (const r of others) {
    if (x < r.left || x > r.right) continue
    const w = r.right - r.left
    target = r
    if (me?.kind === 'one' && r.kind === 'one' && x > r.left + w * 0.25 && x < r.right - w * 0.25) mode = 'pair'
    else mode = x < r.left + w / 2 ? 'before' : 'after'
    break
  }
  if (!target && others.length) {
    if (x < others[0]!.left) [target, mode] = [others[0], 'before']
    else if (x > others[others.length - 1]!.right) [target, mode] = [others[others.length - 1], 'after']
  }
  // Back over its own slot, or into the gap it already stands in: nowhere new.
  const keys = rects.map((r) => r.key)
  const from = keys.indexOf(drag.key!)
  if (target && mode !== 'pair') {
    const to = keys.indexOf(target.key) + (mode === 'after' ? 1 : 0)
    if (to === from || to === from + 1) [target, mode] = [undefined, null]
  }
  drag.target = target?.key ?? null
  drag.mode = mode
  const nav = navEl.value?.getBoundingClientRect().left ?? 0
  if (target && mode !== 'pair') drag.caret = (mode === 'before' ? target.left - 2 : target.right + 1) - nav
}

function up(): void {
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', up)
  const s = activeAgentScope.value
  if (drag.moved && s && drag.key && drag.target && drag.mode) {
    const list = entries.value
    if (drag.mode === 'pair') {
      const left = list.find((e) => e.key === drag.target)
      const right = list.find((e) => e.key === drag.key)
      if (left?.kind === 'one' && right?.kind === 'one') pairTabs(s, left.conv.id, right.conv.id)
    } else {
      const keys = list.map((e) => e.key).filter((k) => k !== drag.key)
      const at = keys.indexOf(drag.target)
      keys.splice(drag.mode === 'before' ? at : at + 1, 0, drag.key)
      reorderTabs(s, keys)
    }
  }
  if (drag.moved) {
    dragEnded = true
    setTimeout(() => (dragEnded = false), 0)
  }
  drag.key = null
  drag.moved = false
  drag.dx = 0
  drag.target = null
  drag.mode = null
}
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', up)
})
function fresh(): void {
  const s = activeAgentScope.value
  if (s) startFresh(s)
}
function single(): void {
  const s = activeAgentScope.value
  if (s) closeSplit(s)
}

</script>

<template>
  <section class="panel">
    <!-- Nothing selected is still a first impression: the app says its name. -->
    <div v-if="!w" class="welcome">
      <Wordmark :height="27" class="wm" />
      <p class="tag">Everything in flight, in one window.</p>
      <div class="hints">
        <span class="hint">
          <span class="kbd">⇧⇧</span> jump to a repository or branch, or run anything
        </span>
        <span class="hint"><MousePointerClick class="sm" /> or pick one on the left</span>
      </div>
    </div>

    <template v-else>
      <!-- The bar that used to head this column is above it now, across the
           window (ScopeBar): none of what it carried was about the
           conversation. What is left here is the conversation. -->
      <div class="body">
        <nav ref="navEl" class="strip" :class="{ dragging: drag.moved }" aria-label="Conversations here">
          <!-- Browser tabs: one per conversation, the new one added at the end,
               the + always after the last. A dot only when there is news. -->
          <span v-if="drag.moved && drag.target && drag.mode !== 'pair'" class="caret" :style="{ left: drag.caret + 'px' }" />
          <TransitionGroup name="tab" tag="div" class="tabs">
            <template v-for="e in entries" :key="e.key">
              <div
                v-if="e.kind === 'one'"
                class="tab"
                role="tab"
                :data-tab="e.key"
                data-kind="one"
                :aria-selected="isOn(e)"
                :class="{
                  on: isOn(e),
                  lifted: drag.moved && drag.key === e.key,
                  droppair: drag.mode === 'pair' && drag.target === e.key,
                }"
                :style="drag.moved && drag.key === e.key ? { transform: 'translateX(' + drag.dx + 'px)' } : undefined"
                :title="e.conv.title + (news(e.conv) ? ' — ' + stateWord(e.conv) : '')"
                @pointerdown="down($event, e)"
                @click="renaming === e.conv.id || press(e.conv, $event)"
                @dblclick="startRename(e.conv)"
                @mousedown.middle.prevent="closeOne(e.conv)"
              >
                <span v-if="news(e.conv)" class="dot" :class="dotOf(e.conv)" />
                <input
                  v-if="renaming === e.conv.id"
                  ref="renameEl"
                  v-model="renameDraft"
                  class="pin"
                  maxlength="80"
                  spellcheck="false"
                  @keydown.enter.prevent="commitRename(e.conv)"
                  @keydown.esc.stop.prevent="renaming = null"
                  @blur="commitRename(e.conv)"
                />
                <span v-else class="pt">{{ e.conv.title || 'Untitled' }}</span>
                <button class="px" title="Close tab" @click.stop="closeOne(e.conv)"><X class="xs" /></button>
              </div>
              <!-- Two side by side are one tab: two titles and a line between. -->
              <div
                v-else
                class="tab pairtab"
                role="tab"
                :data-tab="e.key"
                data-kind="pair"
                :aria-selected="isOn(e)"
                :class="{ on: isOn(e), lifted: drag.moved && drag.key === e.key }"
                :style="drag.moved && drag.key === e.key ? { transform: 'translateX(' + drag.dx + 'px)' } : undefined"
                @pointerdown="down($event, e)"
              >
                <template v-for="(c, i) in e.convs" :key="c.id">
                  <span v-if="i === 1" class="split" />
                  <div
                    class="half"
                    :class="{ active: c.id === thread?.id }"
                    :title="c.title + (news(c) ? ' — ' + stateWord(c) : '')"
                    @click="renaming === c.id || press(c, $event)"
                    @dblclick="startRename(c)"
                    @mousedown.middle.prevent="closeOne(c)"
                  >
                    <span v-if="news(c)" class="dot" :class="dotOf(c)" />
                    <input
                      v-if="renaming === c.id"
                      ref="renameEl"
                      v-model="renameDraft"
                      class="pin"
                      maxlength="80"
                      spellcheck="false"
                      @keydown.enter.prevent="commitRename(c)"
                      @keydown.esc.stop.prevent="renaming = null"
                      @blur="commitRename(c)"
                    />
                    <span v-else class="pt">{{ c.title || 'Untitled' }}</span>
                    <button class="px" title="Close tab" @click.stop="closeOne(c)"><X class="xs" /></button>
                  </div>
                </template>
              </div>
            </template>
            <div
              v-if="!thread || hasNewTab(activeAgentScope)"
              key="__new"
              class="tab"
              :class="{ on: !thread }"
              role="tab"
              :aria-selected="!thread"
              @click="fresh"
            >
              <span class="pt">New conversation</span>
              <button v-if="strip.length" class="px" title="Close tab" @click.stop="closeNew"><X class="xs" /></button>
            </div>
          </TransitionGroup>
          <button class="add" title="New conversation" @click="fresh"><Plus class="sm" /></button>
          <button v-if="pair" class="add" title="Back to one" @click="single"><Columns2 class="sm" /></button>
        </nav>
        <div class="panes">
          <template v-if="pair">
            <AgentTab
              v-for="c in pair"
              :key="c.id"
              class="pane"
              :workspace="w"
              :thread-id="c.id"
              :passive="c.id !== thread?.id"
            />
          </template>
          <AgentTab v-else :workspace="w" bare />
        </div>

        <!-- At the end of the tab bar: the list of every conversation here,
             closed ones too, and the stop for the one on screen. -->
        <div class="instr">
          <button
            class="hist"
            :class="{ on: state.historyOpen, waiting: waiting > 0, solo: !conversations.length }"
            :title="conversations.length
              ? conversations.length + ' conversation(s) here — earlier threads on this scope'
              : 'Earlier conversations here'"
            @click="state.historyOpen = !state.historyOpen"
          >
            <History class="sm" />
            <span v-if="conversations.length" class="n">{{ conversations.length }}</span>
          </button>
          <button
            v-if="thread && isLive(thread)"
            class="icon-btn"
            :title="isBusy(thread)
              ? 'Stop what it is doing'
              : 'Let this conversation go — it is between turns and still holding its repositories'"
            @click="stop"
          >
            <CircleStop class="sm" />
          </button>
        </div>

        <!-- §6 — hung from the button above, over the thread rather than
             instead of it. In here, so it is clipped to the conversation's own
             box: a drawer that can spill past the column it belongs to is a
             panel with an animation. -->
        <ConversationDrawer v-if="state.historyOpen" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--surface-work);
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

.body { position: relative; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.panes { flex: 1; min-height: 0; display: flex; }
.panes > * { flex: 1; min-width: 0; }
.panes > .pane + .pane { border-left: 1px solid var(--line); }

/* §7 — the strip. The instruments come up into it: they act on the thread
   that has the composer, and over two panes there is no one bar to sit on. */
.strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 96px 0 10px;
  border-bottom: 1px solid var(--line-soft);
  overflow: hidden;
}
.tabs { display: flex; align-items: center; gap: 2px; min-width: 0; }
/* As a browser draws them: equal widths that give way together, the one on
   screen raised, the others only text until the cursor is on them. */
.tab {
  position: relative;
  flex: 0 1 184px;
  width: 184px;
  min-width: 64px;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 6px 0 12px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  cursor: default;
  user-select: none;
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.tab:hover { background: var(--hover); color: var(--text-muted); }
.tab.on { background: var(--panel-raised); color: var(--text); box-shadow: var(--shadow-xs), inset 0 0 0 1px var(--line); }
.tab.paired:not(.on) { color: var(--text-muted); }
/* The edges between tabs, as a browser draws them: a hairline between two
   resting tabs, gone beside the one on screen or under the cursor. */
.tab + .tab::before, .tabs + .add::before {
  content: '';
  position: absolute;
  left: -2px;
  top: 9px;
  bottom: 9px;
  width: 1px;
  background: var(--line);
  transition: opacity var(--dur-1) var(--ease-soft);
}
.tab.on::before, .tab:hover::before, .tab.on + .tab::before, .tab:hover + .tab::before { opacity: 0; }
.add { position: relative; margin-left: 2px; }
.tabs:has(.tab:last-child.on) + .add::before, .tabs:has(.tab:last-child:hover) + .add::before { opacity: 0; }
.pt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Always there, seen only on the tab on screen or under the cursor: a tab
   does not change width as the cursor crosses it. */
.px {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--text-dim);
  visibility: hidden;
}
.tab:hover .px, .tab.on .px { visibility: visible; }
.px:hover { background: var(--active); color: var(--text); }
.px .xs { width: 11px; height: 11px; }
.add {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
}
.add:hover { background: var(--hover); color: var(--text); }
.pin {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
}
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
.dot.work { background: var(--agent); }
.dot.you { box-shadow: inset 0 0 0 1.75px var(--warn); }
/* §7 — another conversation left it a message, and nothing will read it yet. */
.dot.mail { box-shadow: inset 0 0 0 1.75px var(--accent); }
/* A tab arriving or leaving, and the others closing up — short, and only
   about the tab itself. */
.tab-enter-active, .tab-leave-active { transition: opacity 140ms var(--ease-soft), transform 140ms var(--ease-soft); }
.tab-enter-from, .tab-leave-to { opacity: 0; transform: translateY(3px); }
.tab-leave-active { position: absolute; }
.tab-move { transition: transform 160ms var(--ease-soft); }

/* ── §7 — a pair, one tab with two titles ───────────────────────────────── */
.strip { position: relative; }
.tab.pairtab { flex: 0 1 312px; width: 312px; gap: 0; padding: 0 2px; }
.half {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 100%;
  padding: 0 4px 0 10px;
  color: var(--text-dim);
}
.tab.pairtab.on .half { color: var(--text-muted); }
.tab.pairtab.on .half.active { color: var(--text); }
.half:hover { color: var(--text); }
.half .px { visibility: hidden; }
.half:hover .px, .tab.on .half.active .px { visibility: visible; }
.tab.pairtab .px { visibility: hidden; }
.tab.pairtab .half:hover .px, .tab.pairtab.on .half.active .px { visibility: visible; }
.split { flex: none; width: 1px; height: 14px; background: var(--line-strong); }

/* ── grabbed ───────────────────────────────────────────────────────────── */
.tab { touch-action: none; }
.tab.lifted {
  z-index: 3;
  background: var(--panel-raised);
  color: var(--text);
  box-shadow: var(--shadow-md), inset 0 0 0 1px var(--line);
  cursor: grabbing;
  transition: none;
}
.strip.dragging .tab:not(.lifted) { transition: background var(--dur-1) var(--ease-soft); }
.strip.dragging .tab::before { opacity: 0; }
/* Dropped here, the two open side by side. */
.tab.droppair { background: var(--accent-soft); color: var(--text); box-shadow: inset 0 0 0 1px var(--accent); }
/* Dropped here, it goes in this gap. */
.caret {
  position: absolute;
  z-index: 4;
  top: 10px;
  bottom: 10px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
.body :deep(.drawer) { top: 44px; }

/* Over the right end of the tab bar, whose padding keeps the room. One pixel
   apart: buttons of one set touch. The history button has a fixed width so the
   count never moves the stop beside it. */
.instr {
  position: absolute;
  z-index: 5;
  top: 8px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 1px;
}
.hist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 44px;
  height: 28px;
  font-variant-numeric: tabular-nums;
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.hist.solo { width: 28px; }
.hist:hover { color: var(--text); background: var(--hover); }
.hist.on { color: var(--accent); background: var(--accent-soft); }
/* One of them is asking something. The count is the thing that says so. */
.hist.waiting { color: var(--warn); }
.hist .n { color: inherit; font-weight: 500; }
</style>
