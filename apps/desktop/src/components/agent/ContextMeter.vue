<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Conversation } from '@cockpit/shared'

/**
 * §6 + §16 — how full the window is, what the thread has cost, and where both
 * numbers came from.
 *
 * It was a gauge and two numbers in the conversation's own bar, at the top of
 * the column. That put it as far from the box as a control can get in this
 * panel, and the box is where the question about it is asked: the moment
 * anyone wants to know how much room is left is the moment they are deciding
 * how much to type. So it sits at the end of the settings row under the well
 * now, beside the model and the effort — the three things that decide what
 * comes back, and the one that says whether it still can.
 *
 * A ring rather than a bar, because that row is a line of words and a 46px
 * rule reads as a divider in it. The percentage stays outside the ring and the
 * cost stays beside it: §16 asks for the cost *displayed*, and a number behind
 * a click is not displayed. Everything that was only ever true on inspection —
 * the tokens either side of the cache line, which model answered, what the
 * last turn spent — is in the panel this opens.
 */
const props = defineProps<{ session: Conversation }>()

/** 15535 → "15.5k", 228_400 → "228k", 1_000_000 → "1M". */
function k(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const t = n / 1000
    return (t < 100 ? t.toFixed(1) : Math.round(t)) + 'k'
  }
  const m = n / 1_000_000
  return (m < 10 ? Number(m.toFixed(2)) : Math.round(m)) + 'M'
}

/**
 * Money at the precision the number deserves. A tenth of a cent rounded to
 * "$0.00" reads as free, which is the one thing a cost display must never say.
 */
function money(n: number): string {
  if (n >= 1) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(3)
  return n > 0 ? '$' + n.toFixed(4) : '$0'
}

const u = computed(() => props.session.usage)
const pct = computed(() =>
  u.value?.contextWindow
    ? Math.min(100, Math.round((u.value.contextTokens / u.value.contextWindow) * 100))
    : 0,
)

/**
 * Where a window stops being a curiosity and starts being the reason answers
 * are getting worse — the same line the banner over the composer draws, stated
 * once in each place it is shown rather than shared through the store for the
 * sake of it.
 */
const CROWDED = 70
const crowded = computed(() => pct.value >= CROWDED)

/**
 * The last turn that reported anything. Not simply `history.at(-1)`: a turn in
 * flight has no usage yet, and a panel that blanked its lower half for the
 * length of every answer would be at its least useful exactly while the number
 * above it is moving.
 */
const turn = computed(() => [...props.session.history].reverse().find((t) => t.usage) ?? null)

/**
 * The bar, in the three parts the engine actually distinguishes.
 *
 * `contextCached` is the conversation as it already stood — read back at a
 * tenth of the price. The rest of the level is what this turn had to send
 * whole: fresh prompt tokens plus whatever was written into the cache for next
 * time. Derived as the remainder rather than added up from `input +
 * cacheCreation`, so the three segments are guaranteed to close and a turn
 * whose figures do not quite reconcile shows as it is rather than as a bar with
 * a gap in it.
 *
 * Per-call and not the turn's `cacheRead`: that one sums every call the turn
 * made, so a turn that read twenty files reported more cache than the window
 * can hold and the segment clamped to the whole bar.
 */
const seg = computed(() => {
  const win = u.value?.contextWindow ?? 0
  const level = u.value?.contextTokens ?? 0
  if (!win) return null
  const cached = Math.min(turn.value?.usage?.contextCached ?? 0, level)
  return {
    cached,
    fresh: Math.max(0, level - cached),
    free: Math.max(0, win - level),
    w: (n: number) => (n / win) * 100 + '%',
  }
})

/* ── the ring ────────────────────────────────────────────────────────────
 *
 * Drawn as one stroked circle with a gap in it rather than two arcs: r = 6 on
 * a 16 box gives a circumference of 37.70, and the dash is that times the
 * fill. The transition is on `stroke-dasharray`, so the ring fills rather than
 * jumps when a turn lands. */
const R = 6
const C = 2 * Math.PI * R
const dash = computed(() => (C * Math.min(100, pct.value)) / 100 + ' ' + C)

/* ── opening, closing, and the clock that only runs while it is open ───── */

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const now = ref(Date.now())
let clock: number | null = null

function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
watch(open, (isOpen) => {
  if (isOpen) {
    now.value = Date.now()
    clock = window.setInterval(() => (now.value = Date.now()), 30_000)
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
  } else {
    if (clock !== null) clearInterval(clock)
    clock = null
    document.removeEventListener('mousedown', onDocDown)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})

function ago(ts: number): string {
  const m = Math.floor((now.value - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

function secs(from: number, to: number | null): string {
  if (!to) return ''
  const ms = to - from
  if (ms < 1000) return ms + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  const m = Math.floor(ms / 60_000)
  return m + 'm ' + Math.round((ms % 60_000) / 1000) + 's'
}
</script>

<template>
  <div v-if="u && u.contextWindow" ref="root" class="meter">
    <button
      class="trigger"
      :class="{ open, crowded }"
      :aria-expanded="open"
      :title="k(u.contextTokens) + ' of ' + k(u.contextWindow) + ' tokens in context · '
        + money(u.costUsd) + ' so far'"
      @click="open = !open"
    >
      <svg class="ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="track" cx="8" cy="8" :r="R" />
        <circle class="fill" cx="8" cy="8" :r="R" :stroke-dasharray="dash" />
      </svg>
      <span class="num">{{ pct }}%</span>
      <span class="num cost">{{ money(u.costUsd) }}</span>
    </button>

    <!-- Upward and to the right: the composer sits at the foot of the window,
         and this is the last control in its row. -->
    <div v-if="open" class="panel">
      <header class="head">
        <span class="lbl">Context window</span>
        <span class="fig" :class="{ crowded }">
          {{ k(u.contextTokens) }} / {{ k(u.contextWindow) }} ({{ pct }}%)
        </span>
      </header>

      <div v-if="seg" class="bar">
        <i class="s cached" :style="{ width: seg.w(seg.cached) }" />
        <i class="s fresh" :style="{ width: seg.w(seg.fresh) }" />
      </div>

      <ul v-if="seg" class="legend">
        <li><i class="k cached" /> Cached <b>{{ k(seg.cached) }}</b></li>
        <li><i class="k fresh" /> Sent whole <b>{{ k(seg.fresh) }}</b></li>
        <li><i class="k free" /> Free <b>{{ k(seg.free) }}</b></li>
      </ul>

      <!-- §6 — said where the number is, and only that far. The banner over
           the composer carries the same warning with the two buttons that act
           on it, forty pixels from here; repeating the remedy would be one
           sentence written twice on one screen. What this adds is the line the
           number is being read against, which the banner never names. -->
      <p v-if="crowded" class="warn">
        Past {{ CROWDED }}% — answers get worse from here.
      </p>

      <div class="rule" />

      <dl class="facts">
        <div v-if="u.model" class="f">
          <dt>Model</dt>
          <dd>{{ u.model }}</dd>
        </div>
        <div class="f">
          <dt>Cost</dt>
          <dd>{{ money(u.costUsd) }} over {{ session.turns }} turn{{ session.turns === 1 ? '' : 's' }}</dd>
        </div>
        <div v-if="turn?.usage" class="f">
          <dt>Last turn</dt>
          <dd>
            {{ k(turn.usage.input) }} in · {{ k(turn.usage.output) }} out ·
            {{ k(turn.usage.cacheCreation) }} cached · {{ money(turn.usage.costUsd) }}
          </dd>
        </div>
        <div v-if="turn" class="f">
          <dt>Measured</dt>
          <dd>
            end of turn {{ turn.seq }}
            <template v-if="turn.endedAt"> · {{ ago(turn.endedAt) }} · {{ secs(turn.startedAt, turn.endedAt) }}</template>
          </dd>
        </div>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.meter { position: relative; }

/* `.trigger`, deliberately: the settings row strips the border off everything
   by that name and lights it on hover (Composer), so this reads as one of the
   row's controls without restating any of it. */
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  white-space: nowrap;
}
.trigger:hover, .trigger.open { color: var(--text); }
.num { color: var(--text-muted); }
.trigger:hover .num, .trigger.open .num { color: var(--text); }
.cost { color: var(--text-dim); }

.ring { width: 14px; height: 14px; flex: none; overflow: visible; }
.ring circle { fill: none; stroke-width: 2.5; }
.track { stroke: var(--line-strong); }
.fill {
  stroke: var(--text-dim);
  /* From twelve o'clock, clockwise — the direction anything filling is read. */
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  stroke-linecap: round;
  transition: stroke-dasharray var(--dur-3) var(--ease-soft);
}
/* Only once it means something. A ring coloured from 4% teaches nobody where
   the line is. */
.trigger.crowded .num, .trigger.crowded:hover .num { color: var(--warn); }
.trigger.crowded .fill { stroke: var(--warn); }

/* ── the panel ──────────────────────────────────────────────────────────── */
.panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 10;
  width: 320px;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
  font-variant-numeric: tabular-nums;
}

.head { display: flex; align-items: baseline; gap: 10px; }
.lbl { font-size: var(--fs-xs); color: var(--text-dim); }
.fig { margin-left: auto; font-size: var(--fs-xs); color: var(--text); }
.fig.crowded { color: var(--warn); }

/* The whole window, left to right, with what is in it drawn from the left and
   the remainder left as the track: free space is the absence of a segment
   rather than a segment of its own, which is why the legend's third key is an
   outline and the other two are filled. */
.bar {
  display: flex;
  height: 5px;
  margin: 9px 0 8px;
  border-radius: 3px;
  background: var(--line-strong);
  overflow: hidden;
}
.s { display: block; height: 100%; transition: width var(--dur-3) var(--ease-soft); }
.s.cached { background: var(--info); }
.s.fresh { background: var(--accent); }

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 10.5px;
  color: var(--text-dim);
}
.legend li { display: inline-flex; align-items: center; gap: 5px; }
.legend b { font-weight: 550; color: var(--text-muted); }
.k { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.k.cached { background: var(--info); }
.k.fresh { background: var(--accent); }
.k.free { box-shadow: inset 0 0 0 1.5px var(--line-strong); }

.warn {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--warn);
}

.rule { height: 1px; margin: 11px 0; background: var(--line); }

.facts { margin: 0; font-size: 11px; }
.f { display: flex; align-items: baseline; gap: 10px; }
.f + .f { margin-top: 6px; }
.f dt { flex: none; width: 66px; color: var(--text-dim); }
.f dd { margin: 0; flex: 1; color: var(--text-muted); overflow-wrap: anywhere; }
</style>
