<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ChevronRight, CircleAlert, FileCode, FilePen, FilePlus, Hand, ListChecks, Search,
  SquareTerminal, Terminal,
} from '@lucide/vue'

/**
 * One thing the agent did, in the terms of the thing it did.
 *
 * This was a grey line reading `Edit → /some/path`, which is the least useful
 * true statement available: it says something happened without saying what,
 * and a turn made of ten of them cannot be judged at all. The engine has
 * always sent the whole call — the command, the search, both sides of an edit
 * — and the transcript simply threw it away.
 *
 * A card per shape rather than one generic dump: a shell command wants its
 * output, a write wants its diff, and a todo list wants to look like a list.
 */
const props = defineProps<{
  tool: string
  input: Record<string, unknown>
  /** Absent while the call is still running — or never journalled: see `live`. */
  result: { stdout: string; stderr: string; isError: boolean; interrupted: boolean } | null
  denied: boolean
  /**
   * Whether the turn this belongs to is still going.
   *
   * A missing outcome means two different things, and one animated "running"
   * tag was claiming both: on a live turn the call is in flight, and on a turn
   * that finished hours ago its outcome simply never reached the journal.
   * Pulsing at the second one is the window telling a story about work that
   * stopped before it was written.
   */
  live?: boolean
}>()

const open = ref(false)

const str = (k: string): string => {
  const v = props.input[k]
  return typeof v === 'string' ? v : ''
}

/** Repo-relative where possible: the absolute prefix is the same on every row. */
const file = computed(() => {
  const p = str('file_path') || str('path') || str('notebook_path')
  return p.split('/').slice(-3).join('/')
})

const pending = computed(() => !props.result && props.live !== false)
/** No outcome, and nothing left that could produce one (§3.4). */
const orphan = computed(() => !props.result && props.live === false)
const failed = computed(() => props.denied || !!props.result?.isError)

/** The line under the title: the one fact that names *this* call. */
const subject = computed(() => {
  switch (props.tool) {
    case 'Bash':
      return str('command')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return file.value
    case 'Glob':
      return str('pattern')
    case 'Grep':
      return str('pattern') + (str('path') ? '  in ' + str('path').split('/').slice(-2).join('/') : '')
    case 'Task':
      return str('description')
    case 'WebFetch':
      return str('url')
    default:
      return file.value || str('description') || ''
  }
})

const ICONS: Record<string, unknown> = {
  Bash: SquareTerminal,
  Read: FileCode,
  Edit: FilePen,
  NotebookEdit: FilePen,
  Write: FilePlus,
  Glob: Search,
  Grep: Search,
  TodoWrite: ListChecks,
}
const icon = computed(() => ICONS[props.tool] ?? Terminal)

/* ── an edit, as the change it is ─────────────────────────────────────────
 *
 * `Edit` carries both sides of the replacement, so the change is already here
 * and does not need the file re-read to be shown. Whole strings rather than a
 * computed diff: they are the edit exactly as it was made, and inventing hunk
 * boundaries would show something subtly other than what happened.
 */
const edit = computed(() => {
  if (props.tool === 'Edit') {
    const from = str('old_string')
    const to = str('new_string')
    if (!from && !to) return null
    return { from: from.split('\n'), to: to.split('\n') }
  }
  // A Write is all addition, and reads as one.
  if (props.tool === 'Write') {
    const c = str('content')
    return c ? { from: [], to: c.split('\n') } : null
  }
  return null
})

/** Long edits collapse: the shape of the change is in its first lines. */
const EDIT_PREVIEW = 14
const editTrimmed = computed(() => {
  const e = edit.value
  if (!e) return null
  const total = e.from.length + e.to.length
  if (open.value || total <= EDIT_PREVIEW) return { ...e, hidden: 0 }
  const keep = Math.max(2, Math.floor(EDIT_PREVIEW / 2))
  return { from: e.from.slice(0, keep), to: e.to.slice(0, keep), hidden: total - keep * 2 }
})

/* ── a todo list, as a list ───────────────────────────────────────────── */
interface Todo { content: string; status: string }
const todos = computed<Todo[]>(() => {
  if (props.tool !== 'TodoWrite') return []
  const raw = props.input.todos
  if (!Array.isArray(raw)) return []
  return raw.map((t) => {
    const o = t as { content?: unknown; activeForm?: unknown; status?: unknown }
    return {
      content: String(o?.content ?? o?.activeForm ?? ''),
      status: String(o?.status ?? 'pending'),
    }
  })
})

/* ── output ───────────────────────────────────────────────────────────── */
const output = computed(() => {
  const r = props.result
  if (!r) return ''
  return [r.stdout, r.stderr].filter(Boolean).join('\n').replace(/\s+$/, '')
})
const lines = computed(() => (output.value ? output.value.split('\n') : []))
const OUT_PREVIEW = 8
const shown = computed(() => (open.value ? lines.value : lines.value.slice(0, OUT_PREVIEW)))
const moreLines = computed(() => Math.max(0, lines.value.length - OUT_PREVIEW))

/** Only what has something more to show is clickable. */
const expandable = computed(
  () => moreLines.value > 0 || (editTrimmed.value?.hidden ?? 0) > 0,
)
</script>

<template>
  <div class="tc" :class="{ failed, pending }">
    <button class="head" :class="{ flat: !expandable }" :disabled="!expandable" @click="open = !open">
      <span class="ic"><component :is="icon" class="sm" /></span>
      <span class="name">{{ tool }}</span>
      <span class="subj mono">{{ subject }}</span>
      <span class="grow" />
      <span v-if="denied" class="tag warn"><Hand class="xs" /> refused</span>
      <span v-else-if="pending" class="tag run">running</span>
      <span v-else-if="orphan" class="tag none">no outcome recorded</span>
      <span v-else-if="failed" class="tag bad"><CircleAlert class="xs" /> failed</span>
      <ChevronRight v-if="expandable" class="xs chev" :class="{ turned: open }" />
    </button>

    <!-- A todo list is the one payload that is the whole point of the call. -->
    <ul v-if="todos.length" class="todos">
      <li v-for="(t, i) in todos" :key="i" :class="t.status">
        <span class="box" />
        <span class="what">{{ t.content }}</span>
      </li>
    </ul>

    <!-- The change itself, in the colours the review pane already uses. -->
    <div v-if="editTrimmed" class="diff mono">
      <div v-for="(l, i) in editTrimmed.from" :key="'d' + i" class="dl del">
        <span class="sg">−</span><span class="tx">{{ l }}</span>
      </div>
      <div v-for="(l, i) in editTrimmed.to" :key="'a' + i" class="dl add">
        <span class="sg">+</span><span class="tx">{{ l }}</span>
      </div>
      <button v-if="editTrimmed.hidden" class="more" @click="open = true">
        {{ editTrimmed.hidden }} more lines
      </button>
    </div>

    <div v-if="shown.length" class="out mono">
      <div v-for="(l, i) in shown" :key="i" class="ol">{{ l }}</div>
      <button v-if="!open && moreLines" class="more" @click="open = true">
        {{ moreLines }} more lines
      </button>
    </div>
    <p v-else-if="result && !todos.length && !editTrimmed && !denied" class="quiet">
      no output
    </p>
  </div>
</template>

<style scoped>
.tc {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  overflow: hidden;
}
.tc.failed { border-color: var(--warn); }

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  text-align: left;
  min-width: 0;
}
.head:not(.flat):hover { background: var(--hover); }
.head.flat { cursor: default; }

.ic {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--hover);
  color: var(--text-dim);
}
.tc.failed .ic { background: var(--warn-soft, var(--hover)); color: var(--warn); }
.ic .lucide { width: 12px; height: 12px; }

.name { flex: none; font-size: var(--fs-xs); font-weight: 600; color: var(--text); }
/* The command is the identity of the call, so it gets the room and the
   truncation rather than the tool name, which is four predictable letters. */
.subj {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow { flex: 0; }

/* Lower case and still: this used to be 9px UPPERCASE, and the running one was
   purple and blinking — a card that had nothing to say shouted the one word it
   had. An outcome is a fact; the badge says it once, at the weight of the rest
   of the line. */
.tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-dim);
}
.tag.warn { color: var(--warn); }
.tag.bad { color: var(--danger); }
.tag.run { color: var(--text-dim); }
.tag.none { color: var(--text-dim); font-style: italic; }
.xs { width: 11px; height: 11px; }
.chev { flex: none; color: var(--text-dim); transition: transform var(--dur-1) var(--ease-soft); }
.chev.turned { transform: rotate(90deg); }

.todos { margin: 0; padding: 2px 10px 9px 11px; list-style: none; }
.todos li { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0; font-size: var(--fs-xs); }
.todos .box {
  flex: none;
  width: 11px;
  height: 11px;
  margin-top: 3px;
  border-radius: 3px;
  border: 1.5px solid var(--line-strong);
}
.todos .what { color: var(--text-muted); line-height: 1.5; }
.todos li.completed .box { background: var(--ok, var(--agent)); border-color: transparent; }
.todos li.completed .what { color: var(--text-dim); text-decoration: line-through; }
.todos li.in_progress .box { border-color: var(--agent); box-shadow: 0 0 0 2px var(--agent-soft); }
.todos li.in_progress .what { color: var(--text); }

.diff, .out {
  padding: 6px 0 7px;
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  line-height: 1.55;
  overflow-x: auto;
}
.dl { display: flex; white-space: pre; }
.dl.add { background: var(--diff-add-bg); }
.dl.del { background: var(--diff-del-bg); }
.sg { flex: none; width: 20px; text-align: center; user-select: none; opacity: 0.7; }
.tx { padding-right: 14px; }
.dl.add .sg, .dl.add .tx { color: var(--diff-add-text); }
.dl.del .sg, .dl.del .tx { color: var(--diff-del-text); }

.ol { padding: 0 11px; white-space: pre; color: var(--text-dim); }
.quiet { margin: 0; padding: 5px 11px 8px; font-size: 10px; color: var(--text-dim); font-style: italic; }

.more {
  display: block;
  margin: 4px 0 0 11px;
  font-size: 10px;
  color: var(--text-dim);
}
.more:hover { color: var(--accent); }
</style>
