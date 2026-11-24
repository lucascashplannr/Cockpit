<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUp, Check, X } from '@lucide/vue'
import type { AgentWrap } from '@cockpit/shared'

/**
 * Where the work stands once a turn is over — the agent's own recap
 * (`wrap_up`, core `wrapTools.ts`), as a card under the latest answer.
 *
 * As little chrome as a card can have: a hairline and the words. No fill, no
 * heading, no icon — the muted ink already says it is beside the answer
 * rather than part of it, and the X only shows when the pointer is on it.
 *
 * Mostly the recap alone. A choice sits inside it only when the agent left a
 * decision that is the person's to make; a reply goes in as their message,
 * exactly as written. The first is the agent's pick, and the one accent on the card.
 *
 * Or, when the person asked for it, the git the agent may not run itself
 * (`wrap.git`), in a soft well at the foot of the card: the message, how
 * many files and where under it, and the button. Pressing it is the confirmation; the X is "not now".
 * The file names and the full message are the row's tooltip. Once it ran, the
 * row says what it came to instead.
 */
const props = defineProps<{
  wrap: AgentWrap
  /** Replies can go in: the conversation is not mid-turn and nothing locks it. */
  canReply: boolean
  /** Where `wrap.git` lands, as the window last saw that checkout. */
  target?: { repo: string; branch: string | null; changes: number | null; several: boolean } | null
  /** The git button was pressed and has not come back. */
  running?: boolean
}>()

const emit = defineEmits<{
  reply: [text: string]
  git: [said: { verb: string; done: string; lines: string[] }]
  dismiss: []
}>()

const files = (n: number) => n + ' file' + (n === 1 ? '' : 's')

/**
 * The proposal as one row: what it says, where it lands, its button's word,
 * and what the toast says after. The question in full is the row's tooltip.
 */
const proposal = computed(() => {
  const g = props.wrap.git
  if (!g) return null
  const t = props.target
  const branch = t?.branch ?? null
  const where = t?.several && t.repo ? ' in ' + t.repo + (branch ? ', on ' + branch : '') : branch ? ' on ' + branch : ''
  const count = g.files.length || t?.changes || 0
  const what = count ? files(count) : 'every change'
  const list = g.files.length ? '\n\n' + g.files.join('\n') : ''
  if (g.message) {
    const subject = g.message.split('\n')[0]!.slice(0, 120)
    return {
      text: subject,
      meta: what + where,
      tip: 'Commit ' + what + where + (g.push ? ' and push' : '') + '\n\n' + g.message + list,
      verb: g.push ? 'Commit & push' : 'Commit',
      push: g.push,
      done: 'Committed ' + what + where + (g.push ? ' and pushed' : ''),
      lines: [subject],
    }
  }
  if (g.files.length && !g.push) {
    return {
      text: g.files.join(', '),
      meta: what + where,
      tip: 'Stage ' + what + where + list,
      verb: 'Stage',
      push: false,
      done: 'Staged ' + what + where,
      lines: [],
    }
  }
  const named = (branch ?? 'this branch') + (t?.several && t.repo ? ' of ' + t.repo : '')
  return {
    text: named + ' to origin',
    meta: '',
    tip: 'Push ' + named + ' to origin',
    verb: 'Push',
    push: false,
    done: 'Pushed ' + named + ' to origin',
    lines: [],
  }
})

const asking = computed(() => !!proposal.value && !props.wrap.done?.ok)

function go(): void {
  const p = proposal.value
  if (p) emit('git', { verb: p.verb, done: p.done, lines: p.lines })
}
</script>

<template>
  <div class="wcard" :class="{ choosing: !!(wrap.ask && wrap.replies.length) || asking }">
    <div class="top">
      <p class="recap selectable">{{ wrap.recap }}</p>
      <button class="x" title="Put it away" aria-label="Put the recap away" @click="emit('dismiss')"><X /></button>
    </div>
    <div v-if="proposal && wrap.done?.ok" class="well">
      <Check class="ok" />
      <span class="txt selectable">{{ wrap.done.text }}</span>
    </div>
    <div v-else-if="proposal" class="well" :title="proposal.tip">
      <div class="words">
        <span class="txt selectable">{{ proposal.text }}</span>
        <span v-if="proposal.meta" class="meta">{{ proposal.meta }}</span>
      </div>
      <button class="b first go" :disabled="running" @click="go">
        <ArrowUp v-if="proposal.push && !running" class="bi" />{{ running ? 'Working' : proposal.verb }}
      </button>
    </div>
    <template v-else-if="wrap.ask && wrap.replies.length">
      <p class="q selectable">{{ wrap.ask }}</p>
      <div class="acts">
        <button
          v-for="(r, i) in wrap.replies"
          :key="r"
          class="b"
          :class="{ first: i === 0 }"
          :disabled="!canReply"
          :title="'Send “' + r + '”'"
          @click="emit('reply', r)"
        >
          {{ r }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wcard {
  margin: 14px 0 4px;
  padding: 13px 10px 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.top { display: flex; align-items: flex-start; gap: 9px; }
.recap {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--text-muted);
}
.x {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin: -2px 0 0;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
/* Only while the pointer is on the card — or while it asks, when putting it
   away is one of the answers. */
.wcard:hover .x, .wcard.choosing .x, .x:focus-visible { opacity: 1; }
.x:hover { color: var(--text); background: var(--hover); }
.x .lucide { width: 13px; height: 13px; }
.q {
  margin: 14px 0 0;
  font-size: var(--fs-sm);
  font-weight: 550;
  line-height: 1.45;
  color: var(--text);
}
.well {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 6px 0 0;
  padding: 10px 10px 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--hover);
}
.words { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ok { flex: none; width: 14px; height: 14px; color: var(--ok); }
.txt {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta { font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.b {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text);
  transition: background var(--dur-1) var(--ease-soft);
}
.b:not(:disabled):hover { background: var(--hover); }
.b.first { border-color: transparent; background: var(--accent); color: var(--accent-text); font-weight: 550; }
.b.first:not(:disabled):hover { background: var(--accent-hover); }
.b:disabled { opacity: 0.5; cursor: default; }
.b.go { flex: none; gap: 6px; }
.bi { width: 13px; height: 13px; }
</style>
