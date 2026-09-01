<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BranchRef } from '@cockpit/shared'
import { ChevronDown, Cloud, GitBranch, LoaderCircle, Lock, Plus } from '@lucide/vue'
import { client, gitBusy, guard, requestPlan } from '../core/store.js'

/**
 * §2 — where this checkout is, and the one control that moves it.
 *
 * The gap this closes was total: a repository could be *created* on a new
 * branch, rebased, pushed and merged, and never put onto a branch that already
 * existed. "I work on dev, and when I am happy I merge to main" — the plainest
 * thing anyone does with two branches — had no answer in this window at all.
 * A topic is the wrong instrument for it: a topic is a branch *per repository
 * in its own folder*, and this is one checkout moving between two branches
 * that are already there.
 *
 * It is the branch label itself, made pressable, because that is where the eye
 * already goes to ask the question.
 */

const props = defineProps<{ workspaceId: string; branch: string }>()

const open = ref(false)
const loading = ref(false)
const branches = ref<BranchRef[]>([])
const q = ref('')
const root = ref<HTMLElement | null>(null)
const field = ref<HTMLInputElement | null>(null)

/**
 * §3.9's rule applied to time rather than capability: while git is moving this
 * checkout, the control that moves it is not one you have. Disabled and saying
 * why, rather than accepting a second click that would queue a switch behind a
 * switch — the working tree is mid-change and the branch list is already stale.
 */
const busy = computed(() => !!gitBusy[props.workspaceId])
watch(busy, (b) => { if (b) open.value = false })

async function toggle() {
  if (busy.value) return
  open.value = !open.value
  if (!open.value) return
  q.value = ''
  // §3.4 — probed on every open, never remembered: a branch made in the
  // terminal tab a second ago has to be in this list.
  loading.value = true
  const r = await guard(() => client.call('git.branches', { workspaceId: props.workspaceId }))
  branches.value = r ?? []
  loading.value = false
  await nextTick()
  field.value?.focus()
}

const matches = computed(() => {
  const t = q.value.trim().toLowerCase()
  const all = branches.value.filter((b) => !b.current)
  return t ? all.filter((b) => b.name.toLowerCase().includes(t)) : all
})
const local = computed(() => matches.value.filter((b) => !b.remoteOnly))
const remote = computed(() => matches.value.filter((b) => b.remoteOnly))

/**
 * The typed text as a *new* branch, offered only when it is a name git will
 * take and nothing already answers to it. One field doing both jobs rather
 * than a second dialog — and `window.prompt` does not exist in Electron, so a
 * dialog here would have been a whole component to ask for one word.
 */
const VALID = /^(?![-/.])(?!.*\.\.)(?!.*[~^:?*[\\\s])(?!.*\/$)(?!.*\.lock$)[\w./-]+$/
const canCreate = computed(() => {
  const t = q.value.trim()
  if (!t || !VALID.test(t)) return false
  return !branches.value.some((b) => b.name === t || b.name.replace(/^[^/]+\//, '') === t)
})

/**
 * Why the list is empty, in the terms that are actually true.
 *
 * One message for three different situations read as a bug: typing the branch
 * you are standing on answered "that is not a name git will take", which is
 * both wrong and insulting about a name git gave it.
 */
const emptyNote = computed(() => {
  const t = q.value.trim()
  if (!t) return 'This is the only branch here.'
  if (branches.value.some((b) => b.current && b.name === t)) return 'You are already on “' + t + '”.'
  if (branches.value.some((b) => b.name === t || b.name.replace(/^[^/]+\//, '') === t)) {
    return '“' + t + '” is not available here.'
  }
  return 'Nothing matches, and “' + t + '” is not a name git will take.'
})

function pick(b: BranchRef) {
  if (b.current || b.checkedOutAt) return
  open.value = false
  // No dialog for a switch that has nothing to say — VS Code does not put one
  // in the way either, and neither did anything before this feature existed.
  // The plan decides: a dirty tree, a mid-rebase or a branch another worktree
  // is holding all raise a warning, and a warning still gets read first.
  void requestPlan(
    props.workspaceId,
    'switch',
    { name: b.name, ...(b.remoteOnly ? { remote: 'true' } : {}) },
    'whenItMatters',
  )
}

function create() {
  const name = q.value.trim()
  open.value = false
  void requestPlan(props.workspaceId, 'branch', { name }, 'whenItMatters')
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

/** `origin/dev` reads as `dev`, with the cloud beside it saying where it is. */
function shortOf(b: BranchRef): string {
  return b.remoteOnly ? b.name.replace(/^[^/]+\//, '') : b.name
}
function noteOf(b: BranchRef): string {
  if (b.checkedOutAt) return 'in use'
  if (b.ahead || b.behind) return (b.ahead ? '↑' + b.ahead : '') + (b.behind ? ' ↓' + b.behind : '')
  return ''
}
</script>

<template>
  <span ref="root" class="bm">
    <button
      class="chip"
      :class="{ on: open, busy }"
      :disabled="busy"
      :title="busy ? 'Switching branch…' : 'On ' + branch + ' — switch branch'"
      @click="toggle"
    >
      <LoaderCircle v-if="busy" class="sm spin" />
      <GitBranch v-else class="sm" />
      <span class="bn">{{ branch }}</span>
      <ChevronDown v-if="!busy" class="ch" />
    </button>

    <div v-if="open" class="menu bmenu">
      <input
        ref="field"
        v-model="q"
        class="find"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Switch to, or name a new branch…"
      >

      <div class="rows">
        <p v-if="loading" class="hint">Reading the branches…</p>

        <template v-else>
          <button
            v-for="b in local"
            :key="b.name"
            :disabled="!!b.checkedOutAt"
            :title="b.checkedOutAt
              ? 'Already checked out at ' + b.checkedOutAt + ' — git allows a branch in one worktree at a time'
              : b.subject"
            @click="pick(b)"
          >
            <component :is="b.checkedOutAt ? Lock : GitBranch" />
            <span class="nm">{{ b.name }}</span>
            <span v-if="noteOf(b)" class="note">{{ noteOf(b) }}</span>
          </button>

          <!-- On the remote and not here yet. One extra step, said as one extra
               line rather than hidden behind a different control. -->
          <template v-if="remote.length">
            <span class="sec">on origin</span>
            <button v-for="b in remote" :key="b.name" :title="b.subject" @click="pick(b)">
              <Cloud />
              <span class="nm">{{ shortOf(b) }}</span>
              <span class="note">tracks {{ b.name }}</span>
            </button>
          </template>

          <span v-if="canCreate && (local.length || remote.length)" class="rule" />
          <button v-if="canCreate" class="mk" @click="create">
            <Plus />
            <span class="nm">Create branch “{{ q.trim() }}” from here</span>
          </button>

          <p v-if="!local.length && !remote.length && !canCreate" class="hint">
            {{ emptyNote }}
          </p>
        </template>
      </div>
    </div>
  </span>
</template>

<style scoped>
/* `min-width: 0` so the name inside can ellipsis: left at `auto`, this box's
   automatic minimum came out as the whole branch name and the chip refused to
   shrink at all — the kicker and the repository name were collapsing around a
   full-width branch. The floor that stops it reaching zero is a real number on
   `.br` in ContextPanel, where the rest of the ranking lives. */
.bm { position: relative; display: inline-flex; min-width: 0; }

/* The label, made pressable. Reads as text until it is under the cursor —
   it is a fact about where you are first and a control second. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 5px;
  min-width: 0;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.chip:hover:not(:disabled), .chip.on { background: var(--hover); color: var(--text); }
/* Working, not broken: it keeps its ink and loses only the invitation. The
   name stays because it is still the true answer to "where am I" until git
   says otherwise. */
.chip:disabled { cursor: default; }
.chip.busy .bn { color: var(--text-dim); }
.chip.busy .lucide { color: var(--accent); opacity: 1; }
.chip .lucide { flex: none; width: 12px; height: 12px; opacity: 0.85; }
.chip .bn {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip:hover .bn, .chip.on .bn { color: var(--text); }
/* Only ever a hint that there is more here; it is not a select. */
.chip .ch { width: 11px; height: 11px; opacity: 0.5; }

.bmenu {
  top: calc(100% + 4px);
  left: 0;
  width: 320px;
  max-height: 380px;
  padding: 6px;
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

.rows { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.rows > button { width: 100%; }
.rows > button:disabled { opacity: 0.45; cursor: default; }
.rows > button:disabled:hover { background: none; color: var(--text-muted); }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note { margin-left: auto; padding-left: 12px; font-size: 11px; color: var(--text-dim); }
.mk .nm { color: var(--accent); }
.sec {
  padding: 8px 9px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.hint { padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
