<script setup lang="ts">
import { computed } from 'vue'
import { MessageCircleQuestionMark } from '@lucide/vue'
import type { AgentAnswers, AgentQuestion } from '@cockpit/shared'

/**
 * A question the agent asked, and what it was told, as part of the thread.
 *
 * The memory line's row — its measure, its size, its muted ink — with one
 * mark per ask and the questions of that ask hanging under it. It began as two
 * lines per question at the size of the prose, then a row and an icon per
 * question, and a turn with three questions in it read as three more messages
 * either way. Folding it like a run of calls was tried too, and put the
 * question itself a click away from the answer it explains.
 *
 * Never folded *into* a run of calls: the answer is something a person said,
 * and the turn after it cannot be read without it.
 */
const props = defineProps<{
  questions: AgentQuestion[]
  answers: AgentAnswers | null
  /**
   * `waiting` — the card above the box is open on it. `skipped` — closed
   * without an answer. `lost` — the turn ended with nothing recorded either way.
   */
  state: 'waiting' | 'answered' | 'skipped' | 'lost'
}>()

const none = computed(() => (props.state === 'skipped' ? 'skipped' : 'not answered'))
</script>

<template>
  <!-- Hidden while the card over the box is open on it: the same question
       twice on one screen, a line apart, is one of them too many. -->
  <div v-show="state !== 'waiting'" class="qr">
    <MessageCircleQuestionMark class="ic" />
    <div class="asked">
      <p v-for="(q, i) in questions" :key="i" class="row" :title="q.question">
        <span class="q selectable">{{ q.question }}</span>
        <span v-if="answers?.[q.question]" class="a selectable" :title="answers[q.question]">{{ answers[q.question] }}</span>
        <span v-else class="a none">{{ none }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.qr {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 8px 0;
  padding: 4px 8px 4px 4px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* Level with the first question, whatever hangs under it. */
.ic { flex: none; width: 11px; height: 11px; margin-top: 4px; color: var(--text-dim); }
.asked { min-width: 0; flex: 1; }
.row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  margin: 0;
  line-height: 19px;
}
.q { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The only full ink on the line: it is what a person said. */
.a {
  flex: 0 1 auto;
  min-width: 48px;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 550;
}
.a.none { color: var(--text-dim); font-weight: 400; font-style: italic; }
</style>
