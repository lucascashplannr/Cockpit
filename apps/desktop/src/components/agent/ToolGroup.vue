<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, CircleAlert, Hand } from '@lucide/vue'
import ToolCall from './ToolCall.vue'

/**
 * A run of calls, as one sentence.
 *
 * A turn is routinely twenty calls long, and the transcript rendered every one
 * of them as a full card — so reading what an agent did meant scrolling past
 * what it did. The calls are not the work; they are how the work was done, and
 * they belong folded until someone asks.
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

/** Open by default when something in it went wrong; then it is the person's. */
const forced = computed(() => failed.value.length > 0)
const manual = ref<boolean | null>(null)
const open = computed(() => manual.value ?? forced.value)
function toggle(): void {
  manual.value = !open.value
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

const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
const SEARCHES = new Set(['Glob', 'Grep'])

function plural(n: number, one: string, many = one + 's'): string {
  return n + ' ' + (n === 1 ? one : many)
}

/**
 * What happened, in the order it is worth knowing: what was changed first,
 * because that is the only part of a group that touched the repository.
 */
const summary = computed(() => {
  const parts: string[] = []

  const edited = [...new Set(props.calls.filter((c) => EDITS.has(c.tool)).map(name))].filter(Boolean)
  if (edited.length) {
    const shown = edited.slice(0, 2).join(', ')
    parts.push('edited ' + shown + (edited.length > 2 ? ' +' + (edited.length - 2) + ' more' : ''))
  }

  const ran = props.calls.filter((c) => c.tool === 'Bash').length
  if (ran) parts.push('ran ' + plural(ran, 'command'))

  const read = props.calls.filter((c) => c.tool === 'Read').length
  if (read) parts.push('read ' + plural(read, 'file'))

  const searched = props.calls.filter((c) => SEARCHES.has(c.tool)).length
  if (searched) parts.push(plural(searched, 'search', 'searches'))

  if (props.calls.some((c) => c.tool === 'TodoWrite')) parts.push('updated the plan')

  const rest = props.calls.filter(
    (c) => !EDITS.has(c.tool) && !SEARCHES.has(c.tool) && !['Bash', 'Read', 'TodoWrite'].includes(c.tool),
  ).length
  if (rest) parts.push(plural(rest, 'other call'))

  if (!parts.length) return plural(props.calls.length, 'call')
  // Sentence case, once, at the front — the parts read as a list after it.
  return parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1) + (parts.length > 1 ? ', ' + parts.slice(1).join(', ') : '')
})

/**
 * While one is still running, the group says which — a fold that reads the
 * same before and after the work would hide the only thing moving.
 */
const running = computed(() => {
  const c = pending.value[pending.value.length - 1]
  if (!c) return ''
  return c.tool === 'Bash' ? str(c.input, 'command') : name(c) || c.tool
})
</script>

<template>
  <div class="tg" :class="{ open, bad: failed.length }">
    <button class="line" @click="toggle">
      <ChevronRight class="xs chev" :class="{ turned: open }" />
      <span class="what">{{ summary }}</span>
      <span v-if="running" class="live mono">{{ running }}</span>
      <span class="grow" />
      <span v-if="failed.some((c) => c.denied)" class="tag warn"><Hand class="xs" /> refused</span>
      <span v-else-if="failed.length" class="tag bad"><CircleAlert class="xs" /> failed</span>
      <span v-else-if="pending.length" class="dots"><i /><i /><i /></span>
    </button>

    <div v-if="open" class="calls">
      <ToolCall
        v-for="c in calls"
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

/* The command in flight, cut rather than wrapped: the line must not change
   height as each one starts. */
.live {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-dim);
}
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
