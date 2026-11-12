<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { Hourglass } from '@lucide/vue'
import type { BackgroundTask } from '@cockpit/shared'
import DialogShell from '../DialogShell.vue'
import { client } from '../../core/store.js'

/**
 * One background command, opened: what it runs and the end of what it has
 * written, read every 1.5s while it is still going. It stays open once the
 * task ends, on the last output read — that is the moment it is most worth
 * reading — and says so instead of the clock.
 */

const props = defineProps<{ sessionId: string; task: BackgroundTask; running: boolean }>()
const emit = defineEmits<{ close: [] }>()

const text = ref('')
const truncated = ref(false)
const note = ref<string | null>(null)
const read = ref(false)
const pre = ref<HTMLElement | null>(null)
const now = ref(Date.now())

async function fetchLog(): Promise<void> {
  const r = await client.call('agent.taskLog', { sessionId: props.sessionId, taskId: props.task.id }).catch(() => null)
  if (!r) return
  if (!r.ok) {
    // Once it has ended there is nothing more to read, and what was read stands.
    if (!read.value) note.value = r.reason
    return
  }
  const el = pre.value
  // Followed to the bottom only if that is where you were reading.
  const atEnd = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24
  text.value = r.text
  truncated.value = r.truncated
  note.value = null
  read.value = true
  await nextTick()
  if (atEnd && pre.value) pre.value.scrollTop = pre.value.scrollHeight
}

let poll: number | null = null
const clock = window.setInterval(() => (now.value = Date.now()), 1000)
watch(
  () => props.running,
  (on, was) => {
    if (poll !== null) clearInterval(poll)
    poll = null
    // Once more as it ends: a command's last lines are written as it exits,
    // and they are usually the ones that say how it went.
    if (!on) {
      if (was) void fetchLog()
      return
    }
    void fetchLog()
    poll = window.setInterval(() => void fetchLog(), 1500)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (poll !== null) clearInterval(poll)
  clearInterval(clock)
})

function since(from: number): string {
  const s = Math.max(0, Math.floor((now.value - from) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}
</script>

<template>
  <DialogShell :title="task.description || 'A background ' + task.kind" :width="820" :height="560" @close="emit('close')">
    <template #lead><Hourglass class="sm hg" :class="{ done: !running }" /></template>
    <template #head>
      <span v-if="running" class="state" title="Running in the background">{{ since(task.startedAt) }}</span>
      <span v-else class="state" title="The agent picks the conversation up from here">ended</span>
    </template>
    <div class="tl">
      <!-- What was run heads what it printed, the way a terminal shows it. -->
      <div class="term">
        <div v-if="task.command" class="cmdline" title="The command it runs"><span class="ps">$</span><code>{{ task.command }}</code></div>
        <pre ref="pre" class="out">{{ note ?? ((truncated ? '…\n' : '') + (text || (read ? (running ? 'Nothing written yet.' : 'It wrote nothing.') : 'Reading…'))) }}</pre>
      </div>
    </div>
  </DialogShell>
</template>

<style scoped>
.hg { flex: none; color: var(--agent); stroke-width: 1.75; }
.hg.done { color: var(--text-dim); }
.state { flex: none; font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
/* The shell's body opens with 18px; the card is the whole of this dialog, so
   it sits closer to the rule. */
.tl { display: flex; flex-direction: column; height: calc(100% + 8px); margin-top: -8px; padding-bottom: 14px; }
.term {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.55;
}
/* Up to three lines of it, then it scrolls: a long test command is still read whole. */
.cmdline {
  flex: none;
  display: flex;
  gap: 8px;
  max-height: calc(3 * 1.55em + 18px);
  padding: 9px 12px;
  overflow: auto;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text);
}
.cmdline code { font: inherit; white-space: pre-wrap; word-break: break-word; }
.ps { flex: none; color: var(--agent); user-select: none; }
.out {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font: inherit;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
