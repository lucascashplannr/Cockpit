<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  Check, ChevronDown, CircleAlert, CircleCheck, CircleStop, Clock, Copy, Info, Play,
  RefreshCw, Save, Server, TriangleAlert, Trash2, Undo2, X,
} from '@lucide/vue'
import type { ToastItem } from '../core/store.js'
import { dismissToast, holdToast, state } from '../core/store.js'

/**
 * §12 — what the window says back, in the one corner nothing else wants.
 *
 * Bottom centre and bottom right both belong to the composer, and the top
 * centre to the connection banner. This sits over the tail of the workspace
 * list, clear of the rail's own controls, and grows upward so the newest
 * message is the one nearest the eye.
 */

/**
 * What the severity draws when the message has nothing more specific to say.
 * Colour comes from the kind either way; only the glyph is up for negotiation.
 */
const BY_KIND = {
  ok: CircleCheck,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
}

/** What the message is about, when that is the more useful thing to show. */
const BY_ICON = {
  copy: Copy,
  stop: CircleStop,
  play: Play,
  clock: Clock,
  restart: RefreshCw,
  server: Server,
  undo: Undo2,
  save: Save,
  discard: Trash2,
}

function glyph(t: ToastItem) {
  return (t.icon && BY_ICON[t.icon]) || BY_KIND[t.kind]
}

/** Folded detail, by toast id. An error opens itself; nothing else does. */
const open = ref(new Set<number>())
const panes = ref<HTMLElement[]>([])
const copied = ref<number | null>(null)

/**
 * Errors and streaming cards start open; everything else starts folded.
 *
 * `open` holds the *exception* rather than the state, so one Set covers both
 * directions: for a card that starts open, being in it means folded.
 */
function startsOpen(t: ToastItem): boolean {
  return t.kind === 'error' || !!t.stream
}

function expanded(t: ToastItem): boolean {
  return startsOpen(t) ? !open.value.has(t.id) : open.value.has(t.id)
}

/**
 * Output is read from the bottom, so a card that is following a process stays
 * pinned there as lines arrive. Only while it is already at the bottom: a
 * reader who has scrolled up is reading something, and yanking them back down
 * is the behaviour every log view gets wrong.
 */
watch(
  () => state.toasts.map((t) => t.detail ?? '').join('\u0000'),
  async () => {
    const at = panes.value.map((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24)
    await nextTick()
    panes.value.forEach((el, i) => {
      if (at[i] !== false) el.scrollTop = el.scrollHeight
    })
  },
)

function toggle(t: ToastItem): void {
  const s = new Set(open.value)
  s.has(t.id) ? s.delete(t.id) : s.add(t.id)
  open.value = s
}

/** The whole of it — headline and detail — so it can go straight into a report. */
async function copy(t: ToastItem): Promise<void> {
  await navigator.clipboard.writeText(t.detail ? t.text + '\n\n' + t.detail : t.text)
  copied.value = t.id
  window.setTimeout(() => {
    if (copied.value === t.id) copied.value = null
  }, 1400)
}

/** Taking the verb is the whole point of the toast; it has nothing left to say. */
function act(t: ToastItem): void {
  t.action?.run()
  dismissToast(t.id)
}
</script>

<template>
  <div class="deck">
    <TransitionGroup name="t">
      <div
        v-for="t in state.toasts"
        :key="t.id"
        class="toast"
        :class="[t.kind, { wide: t.stream }]"
        @mouseenter="holdToast(t.id, true)"
        @mouseleave="holdToast(t.id, false)"
      >
        <div class="head">
          <span class="ic"><component :is="glyph(t)" class="sm" /></span>
          <span class="msg selectable">{{ t.text }}</span>
          <!-- Beside the message while that is all there is. A toast with a
               body of its own puts it on the row under, with the rest. -->
          <button v-if="t.action && !t.detail" class="act" @click="act(t)">{{ t.action.label }}</button>
          <button class="x" title="Dismiss" @click="dismissToast(t.id)"><X class="sm" /></button>
        </div>

        <pre
          v-if="t.detail && expanded(t)"
          ref="panes"
          class="detail selectable"
          :class="{ stream: t.stream }"
        >{{ t.detail }}</pre>

        <div v-if="t.detail" class="foot">
          <button class="link" @click="toggle(t)">
            <ChevronDown class="chev" :class="{ up: expanded(t) }" />
            {{ expanded(t) ? 'Less' : 'Details' }}
          </button>
          <button class="link" @click="copy(t)">
            <Check v-if="copied === t.id" class="chev" />
            <Copy v-else class="chev" />
            {{ copied === t.id ? 'Copied' : 'Copy' }}
          </button>
          <span class="sp" />
          <button v-if="t.action" class="act" @click="act(t)">{{ t.action.label }}</button>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.deck {
  position: fixed;
  bottom: 22px;
  right: 22px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  /* Flush to the right edge, so the stack reads as one column of cards
     against the window's corner rather than a ragged left margin. */
  align-items: flex-end;
  gap: 8px;
  width: min(520px, calc(100vw - var(--rail-w) - 44px));
  /* Only the cards take the pointer — the space above and beside them, which
     is most of the deck most of the time, stays clickable. */
  pointer-events: none;
}

.toast {
  /* The first line's box. Everything on that row — the glyph, the message, the
     close button — is measured against this one number, so they share a centre
     however tall their own hit areas are. A round 20px rather than a 1.5
     multiple of 13px, which lands on 19.5 and leaves half-pixels everywhere. */
  --line: 20px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 240px;
  max-width: 100%;
  padding: 10px 10px 10px 13px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-md), var(--inset-top);
  font-size: var(--fs-sm);
  color: var(--text);
}
/* Only the two that are not routine wear a colour on the edge. */
.toast.error { border-color: var(--danger-soft); }
.toast.warn { border-color: var(--warn-soft); }

/* Top-aligned on purpose: against a message that wraps, the glyph and the
   close button belong beside its first line, not centred down the whole block.
   That is also why the two of them are pulled back to `--line` below — left at
   their own heights they set the row instead, and the message ended up sitting
   a pixel and a quarter above the centre of its own card. */
.head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.ic {
  flex: none;
  display: flex;
  align-items: center;
  height: var(--line);
  color: var(--text-muted);
}
.toast.ok .ic { color: var(--ok); }
.toast.warn .ic { color: var(--warn); }
.toast.error .ic { color: var(--danger); }
.msg { flex: 1; min-width: 0; line-height: var(--line); }

.detail {
  margin: 0;
  /* Six lines and the start of a seventh. Enough to recognise the failure
     without the toast becoming a panel; the rest is under the scrollbar, and
     the whole of it is one Copy away. */
  max-height: 118px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--panel);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

/* A card sizes to its message, which is right for a sentence and wrong for
   output: lines would land at whatever width the first one happened to be,
   and rewrap as the next arrived. One that is showing work takes the deck. */
.toast.wide { width: 100%; }

/* §8 — a card carrying a process's output is not reporting a reason, it is
   showing the work. Twelve lines rather than six, and the colour of text
   rather than of a footnote, because this is what the click was for. */
.detail.stream {
  max-height: 232px;
  color: var(--text);
}

.foot {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sp { flex: 1; }

.link {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.link:hover { color: var(--text); background: var(--hover); }
.chev { width: 12px; height: 12px; }
.chev.up { transform: rotate(180deg); }

.act {
  flex: none;
  align-self: flex-start;
  /* Keeps its 24px of hit area; gives back what it would have added to the row. */
  margin-block: calc((var(--line) - 24px) / 2);
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--accent);
  transition: background var(--dur-1) var(--ease-soft);
}
.act:hover { background: var(--accent-soft); }

.x {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-block: calc((var(--line) - 22px) / 2);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.x:hover { color: var(--text); background: var(--hover); }

/* It rises into place and fades where it stands. `t-move` is what keeps the
   stack from jumping when one is taken out of the middle of it. */
.t-enter-active, .t-leave-active, .t-move {
  transition: opacity var(--dur-2) var(--ease-soft), transform var(--dur-2) var(--ease);
}
.t-enter-from { opacity: 0; transform: translateY(10px) scale(0.98); }
.t-leave-to { opacity: 0; transform: scale(0.98); }
.t-leave-active { position: absolute; }
</style>
