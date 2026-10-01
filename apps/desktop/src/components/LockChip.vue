<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Conversation, LeaseInfo, Workspace } from '@cockpit/shared'
import { ArrowRight, Lock, LockOpen } from '@lucide/vue'
import {
  activeAgentScope, client, guard, isBusy, isLive, openConversation, openThreadFor, state,
} from '../core/store.js'

/**
 * §7 — a folder an agent has claimed, and what that means for you.
 *
 * It was the word "locked" in amber at the end of the bar's dim run, with the
 * first forty characters of a prompt as its hover. That said neither who held
 * it nor whether it was in your way — and it was amber even when the holder
 * was the conversation you were reading, which is the one lock that asks
 * nothing of anyone.
 *
 * A glyph now, and the sentence behind it: which conversation, since when,
 * what it stops and what it does not, and the one act that applies.
 */

const props = defineProps<{ workspaces: Workspace[] }>()

interface Held {
  lease: LeaseInfo
  /** Every repository here that this one lock covers, by name. */
  names: string[]
  /** The conversation behind it. None means it outlived its process. */
  by: Conversation | null
}

/**
 * One entry per lock, not per repository: a conversation on a topic holds a
 * single lock over all of its branches, and that is one thing to say.
 */
const locks = computed<Held[]>(() => {
  const byId = new Map<string, Held>()
  for (const w of props.workspaces) {
    const lease = w.lease
    if (!lease) continue
    const seen = byId.get(lease.id)
    if (seen) seen.names.push(w.name)
    else {
      byId.set(lease.id, {
        lease,
        names: [w.name],
        by: state.agents.find((c) => c.leaseId === lease.id && isLive(c)) ?? null,
      })
    }
  }
  return [...byId.values()]
})

/** The thread on screen holds a lock of its own, and that one is not news. */
const current = computed(() => openThreadFor(activeAgentScope.value))
const mine = (l: Held) => !!l.by && l.by.id === current.value?.id
const inTheWay = computed(() => locks.value.some((l) => !mine(l)))

function heading(l: Held): string {
  if (!l.by) return 'Locked, with nothing running'
  return mine(l) ? 'Locked by this conversation' : 'Locked by another conversation'
}

const hint = computed(() => {
  const first = locks.value[0]
  return first ? heading(first) + ' — what this means' : ''
})

/** "Init and Init-Backend" — a list, read the way it would be said. */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? 'this folder'
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
}

/** Read when the popover opens: it is not on screen long enough to tick. */
const at = ref(Date.now())
function ago(ts: number): string {
  const m = Math.floor((at.value - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
  if (open.value) at.value = Date.now()
}

function show(c: Conversation) {
  open.value = false
  openConversation(c)
}

/**
 * Offered only with no conversation behind the lock, which is the one case
 * where clearing it cannot interrupt work.
 */
async function clear(leaseId: string) {
  open.value = false
  await guard(() => client.call('lease.release', { leaseId }), 'the lock is cleared')
}

function onDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
/** Innermost layer first — see OverflowMenu for why this is the immediate form. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopImmediatePropagation()
    open.value = false
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <span v-if="locks.length" ref="root" class="lk">
    <button
      class="lkb"
      :class="{ on: open, warn: inTheWay }"
      :title="open ? undefined : hint"
      aria-label="Locked"
      @click="toggle"
    >
      <Lock class="sm" />
    </button>

    <div v-if="open" class="menu lkp">
      <template v-for="l in locks" :key="l.lease.id">
        <span class="rule" />
        <div class="lkc">
          <p class="lkh" :class="{ warn: !mine(l) }"><Lock class="sm" />{{ heading(l) }}</p>

          <!-- Which one, in the words it was started with. -->
          <p v-if="l.by" class="lkq" :title="l.by.title">“{{ l.by.title }}”</p>
          <p class="lkm">
            <template v-if="l.by">{{ isBusy(l.by) ? 'working' : 'open' }} · </template>locked {{ ago(l.lease.acquiredAt) }}
          </p>

          <p v-if="l.by" class="lkx">
            Two agents never share a folder, so no other conversation can start in
            {{ names(l.names) }} until {{ mine(l) ? 'this' : 'that' }} one ends or has sat idle for a few minutes.
            It does not stop you — edit, commit and push as usual.
          </p>
          <p v-else class="lkx">
            {{ names(l.names) }} {{ l.names.length > 1 ? 'are' : 'is' }} still marked in use by a
            conversation that is no longer running. Nothing is working here, and no agent can
            start until the lock is cleared.
          </p>
        </div>

        <button v-if="l.by && !mine(l)" @click="show(l.by)">
          <ArrowRight />Open that conversation
        </button>
        <button v-else-if="!l.by" @click="clear(l.lease.id)">
          <LockOpen />Clear the lock
        </button>
      </template>
    </div>
  </span>
</template>

<style scoped>
/* Its own way out of the bar's drag region: the popover hangs from here, and a
   drag region swallows every click that lands on it. */
.lk { position: relative; flex: none; display: inline-flex; -webkit-app-region: no-drag; }

/* The branch chip's box, with nothing in it but the glyph: it reads as a fact
   until it is under the cursor, like the name beside it. */
.lkb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.lkb:hover, .lkb.on { background: var(--hover); color: var(--text); }
/* A lock is a state, not a failure — and amber only when it is in the way of
   something: held by a conversation that is not the one on screen, or by
   nothing at all. */
.lkb.warn { color: var(--warn); }
.lkb.warn:hover, .lkb.warn.on { background: var(--warn-soft); color: var(--warn); }
.lkb .lucide { width: 13px; height: 13px; }

.lkp {
  top: calc(100% + 4px);
  left: 0;
  width: 300px;
  padding: 6px;
}
.lkc { display: flex; flex-direction: column; gap: 5px; padding: 6px 8px 8px; }
.lkc p { margin: 0; }
.lkh {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.lkh .lucide { flex: none; color: var(--text-dim); }
.lkh.warn .lucide { color: var(--warn); }
/* Two lines of the prompt and no more: it is there to be recognised, not read. */
.lkq {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: 1.45;
  color: var(--text-muted);
}
.lkm { font-size: 11px; color: var(--text-dim); }
.lkc .lkx { margin-top: 3px; font-size: var(--fs-xs); line-height: 1.5; color: var(--text-dim); }
</style>
