<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ShieldQuestionMark } from '@lucide/vue'
import type { PermissionRequest } from '@cockpit/shared'
import { answerPermission } from '../../core/store.js'

/**
 * A tool call the agent is waiting on, spelled out, with the yes and the no.
 *
 * Above the box rather than in the thread: the turn is paused on it, and the
 * box is where you are looking when a turn stops moving. One at a time — the
 * engine asks one at a time, and a stack of questions reads as a form to fill
 * in rather than a decision to make.
 *
 * Kept to a line and a short preview. It sits over the conversation it
 * interrupts, and a card that takes half the pane hides the very turn that
 * explains why the agent wants to do this.
 */
const props = defineProps<{ sessionId: string; requests: PermissionRequest[] }>()

const req = computed(() => props.requests[0] ?? null)
const more = computed(() => Math.max(0, props.requests.length - 1))

function str(key: string): string {
  const v = req.value?.input[key]
  return typeof v === 'string' ? v : ''
}

/** The file it touches, by its last two segments; the whole path is on hover. */
const file = computed(() => str('file_path') || str('notebook_path') || str('path'))
const shortFile = computed(() => file.value.split('/').slice(-2).join('/'))

/**
 * What goes in the preview: the command for a shell call, what would be
 * written for an edit, or whatever single argument names the call.
 */
const preview = computed(() => {
  const text = str('command') || str('new_string') || str('content') || (file.value ? '' : str('url') || str('pattern'))
  const lines = text.split('\n')
  return lines.length > 6 ? lines.slice(0, 6).join('\n') + '\n…' : text
})

/** The engine's own line about the call, unless it only repeats the command or the file. */
const about = computed(() => {
  const d = req.value?.description
  const name = file.value.split('/').pop()
  return d && d !== str('command') && d !== file.value && d !== name ? d : ''
})

/** Clicked once: the answer is in flight, and a second click would be refused. */
const sending = ref(false)
watch(req, () => (sending.value = false))

async function answer(allow: boolean): Promise<void> {
  if (!req.value || sending.value) return
  sending.value = true
  await answerPermission(props.sessionId, req.value.id, allow)
}
</script>

<template>
  <div v-if="req" class="perm" role="alertdialog" aria-label="The agent is asking permission">
    <div class="head">
      <ShieldQuestionMark class="ic" :title="req.reason" />
      <span class="what">
        <b>{{ req.tool }}</b>
        <span v-if="shortFile" class="file" :title="file">{{ shortFile }}</span>
        <span v-if="about" class="about">{{ about }}</span>
      </span>
      <span v-if="more" class="more">+{{ more }}</span>
      <button class="btn" :disabled="sending" @click="answer(false)">Deny</button>
      <button class="btn primary" :disabled="sending" @click="answer(true)">Allow</button>
    </div>
    <pre v-if="preview" class="preview selectable" :title="req.reason">{{ preview }}</pre>
  </div>
</template>

<style scoped>
.perm {
  margin: 0 0 8px;
  padding: 6px 6px 6px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  font-size: var(--fs-xs);
}
.head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ic { flex: none; width: 13px; height: 13px; color: var(--accent); }
.what {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
  color: var(--text);
}
.what b { font-weight: 600; }
.file { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
.about { overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); }
.more { flex: none; color: var(--text-dim); font-size: 11px; }
.btn { flex: none; height: 24px; padding: 0 10px; font-size: 11px; }

.preview {
  margin: 6px 4px 0 21px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-input);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow: auto;
}
</style>
