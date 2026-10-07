<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, ChevronDown, GitBranch, Plus } from '@lucide/vue'

/**
 * §4 — the branch a new one forks from, chosen rather than typed.
 *
 * It was a text field: a name spelled from memory, checked by nothing until
 * the plan failed on `git fetch origin <typo>`. The branches are known — the
 * sheet has already read them — so the field lists them. Typing still works,
 * for the branch pushed a minute ago that this clone has not fetched: the text
 * is offered as itself when nothing answers to it.
 *
 * Empty means "the default", and the default is named: `fallback` is what the
 * control shows when nothing is chosen, so it never reads as unanswered.
 *
 * Two sizes because it is used twice in one sheet: as the field beside the new
 * branch's name, and as the word at the end of a repository's row.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: { name: string; note?: string }[]
    /** What an empty choice resolves to, shown in its place. */
    fallback: string
    variant?: 'field' | 'word' | 'inline'
    loading?: boolean
    /** Said in amber: the chosen branch is not somewhere it needs to be. */
    problem?: string
  }>(),
  { variant: 'field', loading: false, problem: '' },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const q = ref('')
const root = ref<HTMLElement | null>(null)
const field = ref<HTMLInputElement | null>(null)

const matches = computed(() => {
  const t = q.value.trim().toLowerCase()
  return t ? props.options.filter((o) => o.name.toLowerCase().includes(t)) : props.options
})

/** The same test the branch chip uses for a name git will take. */
const VALID = /^(?![-/.])(?!.*\.\.)(?!.*[~^:?*[\\\s])(?!.*\/$)(?!.*\.lock$)[\w./-]+$/
const typed = computed(() => {
  const t = q.value.trim()
  return t && VALID.test(t) && !props.options.some((o) => o.name === t) ? t : ''
})

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  q.value = ''
  await nextTick()
  field.value?.focus()
}

function pick(name: string) {
  emit('update:modelValue', name)
  open.value = false
}

function onEnter() {
  const first = matches.value[0]
  if (first) pick(first.name)
  else if (typed.value) pick(typed.value)
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
  <span ref="root" class="bs" :class="'as-' + variant">
    <button
      class="trigger"
      :class="{ on: open, dflt: !modelValue, warn: !!problem }"
      :title="problem || 'The branch the new one forks from'"
      @click="toggle"
    >
      <span class="v">{{ modelValue || fallback }}</span>
      <ChevronDown class="ch" />
    </button>

    <div v-if="open" class="menu bsmenu">
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
        <button :class="{ sel: !modelValue }" @click="pick('')">
          <Check v-if="!modelValue" />
          <GitBranch v-else />
          <span class="nm">Default</span>
          <span class="bnote">{{ fallback }}</span>
        </button>
        <span class="rule" />
        <p v-if="loading" class="bhint">Reading the branches…</p>
        <template v-else>
          <button
            v-for="o in matches"
            :key="o.name"
            :class="{ sel: o.name === modelValue }"
            :title="o.name + (o.note ? ' — in ' + o.note : '')"
            @click="pick(o.name)"
          >
            <Check v-if="o.name === modelValue" />
            <GitBranch v-else />
            <span class="nm">{{ o.name }}</span>
            <span v-if="o.note" class="bnote">{{ o.note }}</span>
          </button>
          <button v-if="typed" class="mk" title="Not a branch this clone knows yet — it is fetched first" @click="pick(typed)">
            <Plus />
            <span class="nm">Use “{{ typed }}”</span>
          </button>
          <p v-if="!matches.length && !typed" class="bhint">
            {{ q.trim() ? 'Nothing matches.' : 'No branch on origin here.' }}
          </p>
        </template>
      </div>
    </div>
  </span>
</template>

<style scoped>
.bs { position: relative; display: inline-flex; min-width: 0; }
.bs.as-field { flex: none; width: 190px; }

.trigger { display: inline-flex; align-items: center; min-width: 0; }
.trigger .v { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trigger .ch { flex: none; width: 12px; height: 12px; opacity: 0.6; }

/* The field: the box of every other input on the sheet. `as-field`, not
   `field`: a scoped `.field .trigger` also matches inside any *parent's*
   `.field`, which is every form in this app. */
.as-field .trigger {
  width: 100%;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  line-height: 1.55;
  text-align: left;
  transition: border-color var(--dur-1) var(--ease-soft);
}
.as-field .trigger:hover { border-color: var(--line-strong); }
.as-field .trigger.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.as-field .trigger.dflt { color: var(--text-dim); font-family: var(--font); }

/* Inline: the right half of a control that already has a border — it brings
   none of its own, and fills the height it is given. */
.bs.as-inline { flex: none; align-self: stretch; max-width: 46%; }
.as-inline .trigger {
  gap: 6px;
  height: 100%;
  padding: 0 11px 0 7px;
  border-radius: calc(var(--radius-sm) - 1px);
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  transition: background var(--dur-1) var(--ease-soft);
}
.as-inline .trigger:hover, .as-inline .trigger.on { background: var(--hover); }
.as-inline .trigger.dflt { color: var(--text-muted); font-family: var(--font); }

/* The word: text until it is under the cursor, like the branch on the bar. */
.as-word .trigger {
  gap: 3px;
  height: 22px;
  max-width: 180px;
  margin-right: -6px;
  padding: 0 6px;
  border-radius: 5px;
  /* Chosen for this repository: the one row that differs carries the ink. */
  color: var(--text);
  font-size: var(--fs-xs);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.as-word .trigger:hover, .as-word .trigger.on { background: var(--active); color: var(--text); }
.as-word .trigger.dflt { color: var(--text-dim); }
.as-word .trigger .ch { width: 11px; height: 11px; opacity: 0.5; }
.trigger.warn, .trigger.warn.dflt { color: var(--warn); }

.bsmenu {
  top: calc(100% + 4px);
  right: 0;
  width: 280px;
  max-height: 280px;
  padding: 6px;
  animation: pop var(--dur-1) var(--ease-soft);
  transform-origin: top right;
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
.rows > button.sel { color: var(--text); }
.rows > button.sel .lucide { color: var(--accent); }
.nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bnote {
  flex: 0 1 auto;
  min-width: 40px;
  max-width: 50%;
  margin-left: auto;
  padding-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim);
}
.mk .nm { color: var(--accent); }
.bhint { margin: 0; padding: 10px 9px; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
