<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BranchRef } from '@cockpit/shared'
import { matchesBranch } from '@cockpit/shared'
import { Cloud, GitBranch, Plus, ShieldCheck } from '@lucide/vue'
import { client, guard } from '../core/store.js'

/**
 * §16 — one more protected branch for a repository, picked the way the branch
 * chip on the bar picks one to switch to: a search over the branches git has.
 * Only those: typed text is a filter, never a branch of its own (Lucas,
 * 2026-11-18: "you can only protect existing branches").
 *
 * The trigger is the row's + button. The list floats over the page: the sheet
 * scrolls, and an absolute menu inside it was clipped by its edge.
 */

const props = defineProps<{ workspaceId: string; protected: string[]; repo: string }>()
const emit = defineEmits<{ add: [name: string] }>()

const open = ref(false)
const loading = ref(false)
const branches = ref<BranchRef[]>([])
const q = ref('')
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
const place = ref<Record<string, string>>({})

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  q.value = ''
  if (trigger.value) {
    const r = trigger.value.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const up = below < 220
    place.value = {
      position: 'fixed',
      ...(up ? { bottom: window.innerHeight - r.top + 4 + 'px' } : { top: r.bottom + 4 + 'px' }),
      left: Math.max(8, Math.min(r.right - 320, window.innerWidth - 328)) + 'px',
      maxHeight: Math.max(160, Math.min(360, up ? r.top - 12 : below)) + 'px',
      transformOrigin: up ? 'bottom right' : 'top right',
    }
  }
  loading.value = true
  // Read on every open, as the chip does: a branch made a second ago belongs in it.
  const got = await guard(() => client.call('git.branches', { workspaceId: props.workspaceId }))
  branches.value = got ?? []
  loading.value = false
  await nextTick()
  field.value?.focus()
}

/** `origin/dev` is `dev` here: protection is by name, wherever the branch lives. */
const short = (b: BranchRef) => (b.remoteOnly ? b.name.replace(/^[^/]+\//, '') : b.name)

const names = computed(() => {
  const seen = new Set<string>()
  const out: { name: string; remote: boolean }[] = []
  for (const b of branches.value) {
    const n = short(b)
    if (seen.has(n)) continue
    seen.add(n)
    out.push({ name: n, remote: !!b.remoteOnly })
  }
  return out
})

const matches = computed(() => {
  const t = q.value.trim().toLowerCase()
  return t ? names.value.filter((b) => b.name.toLowerCase().includes(t)) : names.value
})

const isOn = (name: string) => props.protected.includes(name)
const coveredBy = (name: string) => (isOn(name) ? null : props.protected.find((p) => p.includes('*') && matchesBranch(name, [p])) ?? null)

function pick(name: string) {
  if (isOn(name)) return
  emit('add', name)
  open.value = false
}
function onEnter() {
  const first = matches.value.find((b) => !isOn(b.name))
  if (first) pick(first.name)
}

function onDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
/** Innermost layer first: the list closes before the sheet it is in. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopImmediatePropagation()
    open.value = false
  }
}
/** Pinned where the + was: when the sheet scrolls or the window resizes, it closes rather than drift. */
function onMove(e: Event) {
  if (e.type === 'scroll' && root.value?.contains(e.target as Node)) return
  open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onMove)
  document.addEventListener('scroll', onMove, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onMove)
  document.removeEventListener('scroll', onMove, true)
})
</script>

<template>
  <span ref="root" class="pm">
    <button
      ref="trigger"
      class="icon-btn"
      :class="{ on: open }"
      :title="'Protect a branch of ' + repo"
      @click="toggle"
    >
      <Plus />
    </button>

    <div v-if="open" class="menu pmenu" :style="place">
      <input
        ref="field"
        v-model="q"
        class="find"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Find a branch…"
        @keydown.enter.prevent="onEnter"
      >
      <div class="rows">
        <p v-if="loading" class="hint">Reading the branches…</p>
        <template v-else>
          <button
            v-for="b in matches"
            :key="b.name"
            :disabled="isOn(b.name)"
            :title="isOn(b.name) ? b.name + ' is protected' : 'Protect ' + b.name"
            @click="pick(b.name)"
          >
            <component :is="isOn(b.name) || coveredBy(b.name) ? ShieldCheck : b.remote ? Cloud : GitBranch" />
            <span class="nm">{{ b.name }}</span>
            <span v-if="isOn(b.name)" class="note">protected</span>
            <span v-else-if="coveredBy(b.name)" class="note">{{ coveredBy(b.name) }}</span>
          </button>

          <p v-if="!matches.length" class="hint">
            {{ q.trim() ? 'Nothing matches.' : 'No branches here.' }}
          </p>
        </template>
      </div>
    </div>
  </span>
</template>

<style scoped>
/* BranchMenu's list, to the pixel: the same search over the same branches. */
.pm { position: relative; display: inline-flex; flex: none; }
.pm > .icon-btn .lucide { width: 14px; height: 14px; }

.pmenu {
  width: 320px;
  padding: 6px;
  animation: pop var(--dur-1) var(--ease-soft);
}
@keyframes pop {
  from { opacity: 0; transform: translateY(-3px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
.find {
  flex: none;
  height: 30px;
  margin-bottom: 5px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: var(--font);
}
.find:focus { outline: none; border-color: var(--focus-ring); }
.find::placeholder { color: var(--text-dim); }

.rows { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.rows > button { flex: none; width: 100%; min-width: 0; height: 26px; }
.rows > button:disabled { opacity: 0.45; cursor: default; }
.rows > button:disabled:hover { background: none; color: var(--text-muted); }
.nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note { flex: none; margin-left: auto; padding-left: 12px; font-size: 11px; color: var(--text-dim); }
.hint { margin: 0; padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
