<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Check } from '@lucide/vue'
import { questionsIn, type AgentAnswers, type PermissionRequest } from '@cockpit/shared'
import { answerPermission } from '../../core/store.js'

/**
 * Something the agent asked, with the choices it offered.
 *
 * Where `PermissionAsk` sits, for the same reason: the turn is stopped on it,
 * and the box is where you are looking when a turn stops moving. It is the
 * other thing the engine can wait on a person for — not "may I", but "which".
 *
 * One question on screen at a time, however many came in the call. Four
 * questions with four options each is a form, and a form over the thread hides
 * the turn that explains why any of it is being asked. The headers along the
 * top are the way between them, and say which are answered.
 *
 * Every question takes words of your own as well as its options: the agent
 * wrote the choices before it knew what you would say, and the right answer is
 * often none of them.
 */
const props = defineProps<{ sessionId: string; request: PermissionRequest; more: number }>()

const questions = computed(() => questionsIn(props.request.input))

/** What is chosen so far, per question: the options taken, and the words typed. */
interface Draft { picked: string[]; other: string }
const drafts = ref<Draft[]>([])
const at = ref(0)
/** Clicked once: the answer is in flight, and a second click would be refused. */
const sending = ref(false)

watch(
  () => props.request.id,
  () => {
    drafts.value = questions.value.map(() => ({ picked: [], other: '' }))
    at.value = 0
    sending.value = false
  },
  { immediate: true },
)

const q = computed(() => questions.value[at.value] ?? null)
const draft = computed(() => drafts.value[at.value] ?? null)
const last = computed(() => at.value >= questions.value.length - 1)

/** The answer as the engine wants it: one string, several choices joined. */
function answerOf(i: number): string {
  const d = drafts.value[i]
  if (!d) return ''
  const other = d.other.trim()
  return [...d.picked, ...(other ? [other] : [])].join(', ')
}
const answered = (i: number): boolean => !!answerOf(i)
const complete = computed(() => questions.value.every((_, i) => answered(i)))

const otherBox = ref<HTMLInputElement | null>(null)

function pick(label: string): void {
  const d = draft.value
  if (!d || !q.value || sending.value) return
  if (q.value.multiSelect) {
    d.picked = d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label]
    return
  }
  // One choice: taking an option is the answer, and words typed before it
  // would make it two.
  d.picked = [label]
  d.other = ''
  if (!last.value) at.value++
}

/** Typing your own answer to a single-choice question replaces the option taken. */
function typed(): void {
  const d = draft.value
  if (d && q.value && !q.value.multiSelect && d.other.trim()) d.picked = []
}

function next(): void {
  if (!answered(at.value)) return
  if (last.value) void submit()
  else {
    at.value++
    void nextTick(() => otherBox.value?.blur())
  }
}

/**
 * The digits take the option they number, and Enter moves on — on the card
 * only, never on the window: the box under it is where the next thing is being
 * typed, and a 2 in a sentence is not a choice.
 */
function key(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey || !q.value) return
  if (e.target instanceof HTMLInputElement) return
  if (e.key === 'Enter') {
    e.preventDefault()
    next()
    return
  }
  const n = Number(e.key)
  if (!Number.isInteger(n) || n < 1) return
  const o = q.value.options[n - 1]
  if (o) pick(o.label)
  else if (n === q.value.options.length + 1) otherBox.value?.focus()
  else return
  e.preventDefault()
}

/**
 * Taken only from a box with nothing in it. A card that grabbed the keyboard
 * mid-sentence would turn the rest of the sentence into answers.
 */
const card = ref<HTMLElement | null>(null)
onMounted(() => {
  const el = document.activeElement
  const typing = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && !!el.value
  if (!typing) card.value?.focus({ preventScroll: true })
})

async function submit(): Promise<void> {
  if (!complete.value) {
    // Go to the one still open rather than refuse without saying which.
    at.value = questions.value.findIndex((_, i) => !answered(i))
    return
  }
  if (sending.value) return
  sending.value = true
  const answers: AgentAnswers = {}
  questions.value.forEach((x, i) => (answers[x.question] = answerOf(i)))
  await answerPermission(props.sessionId, props.request.id, true, answers)
  sending.value = false
}

async function skip(): Promise<void> {
  if (sending.value) return
  sending.value = true
  await answerPermission(props.sessionId, props.request.id, false)
  sending.value = false
}
</script>

<template>
  <div
    v-if="q && draft"
    ref="card"
    class="qask"
    role="alertdialog"
    aria-label="The agent is asking you a question"
    tabindex="-1"
    @keydown="key"
  >
    <div class="head">
      <div v-if="questions.length > 1" class="steps" role="tablist">
        <button
          v-for="(x, i) in questions"
          :key="i"
          class="step"
          :class="{ on: i === at, done: answered(i) }"
          role="tab"
          :aria-selected="i === at"
          :title="x.question"
          @click="at = i"
        >
          <Check v-if="answered(i)" class="tick" />{{ x.header || 'Question ' + (i + 1) }}
        </button>
      </div>
      <span v-else-if="q.header" class="header">{{ q.header }}</span>
      <span class="grow" />
      <span v-if="more" class="more" title="More waiting behind this one">+{{ more }}</span>
    </div>

    <p class="question selectable">{{ q.question }}</p>

    <div class="options" :role="q.multiSelect ? 'group' : 'radiogroup'">
      <button
        v-for="o in q.options"
        :key="o.label"
        class="opt"
        :class="{ on: draft.picked.includes(o.label), multi: q.multiSelect }"
        :role="q.multiSelect ? 'checkbox' : 'radio'"
        :aria-checked="draft.picked.includes(o.label)"
        :disabled="sending"
        @click="pick(o.label)"
      >
        <span class="key"><Check v-if="draft.picked.includes(o.label)" /><template v-else>{{ q.options.indexOf(o) + 1 }}</template></span>
        <span class="words">
          <span class="label">{{ o.label }}</span>
          <span v-if="o.description" class="desc">{{ o.description }}</span>
        </span>
      </button>
      <label class="opt other" :class="{ on: !!draft.other.trim(), multi: q.multiSelect }">
        <span class="key"><Check v-if="draft.other.trim()" /><template v-else>{{ q.options.length + 1 }}</template></span>
        <input
          ref="otherBox"
          v-model="draft.other"
          class="own"
          :placeholder="q.multiSelect ? 'Something else, as well' : 'Something else'"
          :disabled="sending"
          @input="typed"
          @keydown.enter.prevent="next"
        />
      </label>
    </div>

    <div class="foot">
      <button class="btn" :disabled="sending" title="Leave it to the agent's judgement" @click="skip">Skip</button>
      <span class="grow" />
      <button v-if="!last" class="btn" :disabled="!answered(at)" @click="at++">Next</button>
      <button class="btn primary" :disabled="sending || !complete" @click="submit">Answer</button>
    </div>
  </div>
</template>

<style scoped>
/* The composer's own surface and edge, not a tinted card of its own: it is the
   box asking instead of being asked, and the only accent on it is what you
   have chosen. The first draft was an accent-bordered panel of filled radio
   rows, which read as a form dropped onto the conversation.

   Not `.ask`: the tab that hosts this card calls a person's message that, and
   a parent's scoped rule reaches a child's root — the card was being laid out
   as a chat bubble, shrunk to its widest option against the right edge. */
.qask {
  margin: 0 0 8px;
  padding: 12px 10px 10px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-input);
  font-size: var(--fs-sm);
}
.qask:focus { outline: none; }
.head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.grow { flex: 1; }
.header { font-size: var(--fs-xs); font-weight: 500; color: var(--text-dim); }
.more { flex: none; color: var(--text-dim); font-size: var(--fs-xs); }

/* The tabs are a control and the question is the heading under them: the
   extra room is what keeps the two from reading as one block. */
.steps { display: flex; gap: 2px; min-width: 0; margin: 0 0 6px -7px; overflow: hidden; }
.step {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: nowrap;
}
.step:hover { color: var(--text); }
.step.on { background: var(--hover); color: var(--text); font-weight: 600; }
.tick { width: 11px; height: 11px; color: var(--accent); stroke-width: 2.5; }

.question {
  margin: 6px 4px 10px 0;
  font-size: var(--fs-md);
  font-weight: 550;
  line-height: 1.45;
  color: var(--text);
}

.options {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: -8px;
  /* A long list scrolls inside the card: the thread behind it is the reason
     for the question, and stays in view. */
  max-height: 260px;
  overflow: auto;
}
.opt {
  display: flex;
  /* From the top, not the middle: a description that runs to a second line
     left its digit floating between the two, level with neither. */
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  line-height: 20px;
  color: var(--text);
}
.opt:hover:not(:disabled) { background: var(--hover); }
.opt.on { background: var(--selected); }
/* The digit that takes the row, until the row is taken. */
.key {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  /* Centred on the first line of the row, whatever follows it. */
  margin-top: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1;
  color: var(--text-dim);
}
.key .lucide { width: 11px; height: 11px; stroke-width: 3; }
.opt.on .key { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
/* One run of text, so a description that wraps comes back under its label.
   As two columns it came back under its own first word, at a different indent
   on every row — as far in as that row's label happened to be long. */
.words { min-width: 0; }
.label { margin-right: 8px; font-weight: 550; }
.desc { color: var(--text-muted); }

.other { cursor: text; }
.own {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
}
.own::placeholder { color: var(--text-dim); }

.foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.btn { flex: none; height: 28px; padding: 0 12px; font-size: var(--fs-xs); }
</style>
