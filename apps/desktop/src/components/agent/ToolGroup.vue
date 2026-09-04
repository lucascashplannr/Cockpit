<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, CircleAlert, Hand } from '@lucide/vue'
import ToolCall from './ToolCall.vue'

/**
 * A run of calls, as one sentence — however few of them there are.
 *
 * A turn is routinely twenty calls long, and the transcript rendered every one
 * of them as a full card — so reading what an agent did meant scrolling past
 * what it did. The calls are not the work; they are how the work was done, and
 * they belong folded until someone asks.
 *
 * It used to take two calls before folding was thought worth a click, which
 * meant a turn's single `cat package.json` still landed as a card with its
 * output in it — the one shape Lucas pointed at and said he does not want to
 * see every day. One call gets the same line as twenty; the line is not a
 * saving of space, it is the level the transcript is read at.
 *
 * What is never folded is a refusal or a failure: those are the two outcomes
 * that change what a person should do next, so a group holding one opens
 * itself and says so on the line.
 */
export interface Call {
  id: string
  tool: string
  input: Record<string, unknown>
  result: { stdout: string; stderr: string; isError: boolean; interrupted: boolean } | null
  denied: boolean
}

const props = defineProps<{
  calls: Call[]
  /** Whether the turn is still going — see `ToolCall.live`. A group in a
   *  finished turn never says anything is running. */
  live?: boolean
}>()

const failed = computed(() => props.calls.filter((c) => c.denied || c.result?.isError))
const pending = computed(() => (props.live === false ? [] : props.calls.filter((c) => !c.result)))

/**
 * What is unfolded, which is three states rather than two.
 *
 * Untouched, a group holding a failure shows *the failure* — not the other
 * nineteen calls that went fine. Unfolding everything because one command
 * exited non-zero was how a turn that ran eight builds put eight cards on
 * screen to tell you about one of them, which is the opposite of what opening
 * on a failure is for.
 *
 * Clicked, it shows all of them; clicked again, none. The line itself always
 * names the failure ("ran 8 commands (1 failed)"), so nothing is ever hidden
 * by the fold — only deferred.
 */
const manual = ref<boolean | null>(null)
const shown = computed(() =>
  manual.value === true ? props.calls : manual.value === false ? [] : failed.value,
)
/** The first click always means "all of them", whatever is already showing. */
function toggle(): void {
  manual.value = manual.value !== true
}

const str = (input: Record<string, unknown>, k: string): string => {
  const v = input[k]
  return typeof v === 'string' ? v : ''
}

/** The last path segment: the directory is the same on every row of a group. */
function name(c: Call): string {
  const p = str(c.input, 'file_path') || str(c.input, 'path') || str(c.input, 'notebook_path')
  return p.split('/').pop() ?? p
}

const WRITES = new Set(['Write'])
const EDITS = new Set(['Edit', 'NotebookEdit'])
const SEARCHES = new Set(['Glob', 'Grep'])

function plural(n: number, one: string, many = one + 's'): string {
  return n + ' ' + (n === 1 ? one : many)
}

/**
 * What happened, counted rather than listed.
 *
 * It used to name the files — "edited auth.vue, router.js +3 more" — which
 * grows with the work and is the half of the line that pushes everything else
 * off the end. A count is the same length whether the turn touched two files
 * or forty, and the names are one click away in the calls themselves.
 *
 * Order: what was changed first, because that is the only part of a group that
 * touched the repository.
 */
const summary = computed(() => {
  const parts: string[] = []
  const count = (has: (t: string) => boolean): number =>
    props.calls.filter((c) => has(c.tool)).length

  const created = count((t) => WRITES.has(t))
  if (created) parts.push('created ' + plural(created, 'file'))

  const edited = count((t) => EDITS.has(t))
  if (edited) parts.push('edited ' + plural(edited, 'file'))

  const ran = props.calls.filter((c) => c.tool === 'Bash')
  if (ran.length) {
    // The failure count rides on the phrase it belongs to rather than only on
    // the badge at the end: "ran 26 commands (1 failed)" says which of the
    // twenty-six is worth opening for.
    const bad = ran.filter((c) => c.denied || c.result?.isError).length
    parts.push('ran ' + plural(ran.length, 'command') + (bad ? ' (' + bad + ' failed)' : ''))
  }

  const read = count((t) => t === 'Read')
  if (read) parts.push('read ' + plural(read, 'file'))

  const searched = count((t) => SEARCHES.has(t))
  if (searched) parts.push(plural(searched, 'search', 'searches'))

  if (props.calls.some((c) => c.tool === 'TodoWrite')) parts.push('updated the plan')

  const rest = count(
    (t) => !WRITES.has(t) && !EDITS.has(t) && !SEARCHES.has(t) && !['Bash', 'Read', 'TodoWrite'].includes(t),
  )
  if (rest) parts.push('used ' + plural(rest, 'other tool'))

  if (!parts.length) return plural(props.calls.length, 'call')
  // Sentence case, once, at the front — the parts read as a list after it.
  return parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1) + (parts.length > 1 ? ', ' + parts.slice(1).join(', ') : '')
})

/**
 * What the group did to the tree, in lines.
 *
 * Both sides of every edit are already in the call — that is what the expanded
 * card draws its diff from — so this costs nothing to know and is the one
 * number that says how big a fold is without opening it. A `Write` is all
 * addition, which is what makes "created 4 files +542 −0" read true.
 *
 * Only ever an estimate of the *edit*, never of the file: a replacement of two
 * lines by two lines counts as both, which is what a diff would say too.
 */
const stat = computed(() => {
  let add = 0
  let del = 0
  for (const c of props.calls) {
    const s = (k: string): string => (typeof c.input[k] === 'string' ? (c.input[k] as string) : '')
    if (c.tool === 'Write') add += s('content').split('\n').length
    else if (EDITS.has(c.tool)) {
      const from = s('old_string')
      const to = s('new_string')
      if (from) del += from.split('\n').length
      if (to) add += to.split('\n').length
    }
  }
  return add || del ? { add, del } : null
})

/*
 * The group used to spell out the command in flight beside its summary. The
 * live line under the turn now names it — held long enough to read, which this
 * never was — so the same long command was on screen twice, one copy of it
 * changing with every call. What is left here is the three dots: this line
 * says *that* something is running, and the line below says what.
 */
</script>

<template>
  <div class="tg" :class="{ bad: failed.length }">
    <button class="line" @click="toggle">
      <ChevronRight class="xs chev" :class="{ turned: shown.length }" />
      <span class="what">{{ summary }}</span>
      <span v-if="stat" class="stat">
        <i class="add">+{{ stat.add }}</i><i class="del">−{{ stat.del }}</i>
      </span>
      <span class="grow" />
      <span v-if="failed.some((c) => c.denied)" class="tag warn"><Hand class="xs" /> refused</span>
      <span v-else-if="failed.length" class="tag bad"><CircleAlert class="xs" /> failed</span>
      <span v-else-if="pending.length" class="dots"><i /><i /><i /></span>
    </button>

    <div v-if="shown.length" class="calls">
      <ToolCall
        v-for="c in shown"
        :key="c.id"
        :tool="c.tool"
        :input="c.input"
        :result="c.result"
        :denied="c.denied"
        :live="live"
      />
    </div>
  </div>
</template>

<style scoped>
.tg { margin: 8px 0; }

.line {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px 5px 4px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: left;
}
.line:hover { background: var(--hover); color: var(--text); }
.tg.bad .line { color: var(--warn); }

.chev { flex: none; color: var(--text-dim); transition: transform var(--dur-1) var(--ease-soft); }
.chev.turned { transform: rotate(90deg); }
.what { flex: none; }

/* What it did to the tree, in the two colours the review pane already uses.
   Tabular figures so a column of these does not shimmer as the numbers grow. */
.stat {
  flex: none;
  display: inline-flex;
  gap: 6px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-style: normal;
}
.stat i { font-style: normal; }
.stat .add { color: var(--ok); }
.stat .del { color: var(--danger); }

.grow { flex: 1; }

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}
.tag.warn { color: var(--warn); }
.tag.bad { color: var(--danger); }
.xs { width: 11px; height: 11px; }

.dots { display: inline-flex; gap: 3px; }
.dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--agent);
  animation: pulse 1.1s var(--ease-soft) infinite;
}
.dots i:nth-child(2) { animation-delay: 0.15s; }
.dots i:nth-child(3) { animation-delay: 0.3s; }

/* Indented under the line that stands for them: they are its detail. */
.calls { margin-left: 14px; padding-left: 8px; border-left: 1px solid var(--line-soft); }
</style>
