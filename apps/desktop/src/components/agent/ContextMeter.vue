<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { CLAUDE_MODELS } from '@cockpit/shared'
import type { ContextBreakdown, Conversation } from '@cockpit/shared'
import { client } from '../../core/store.js'
import { CROWDED, useContextLevel } from './contextLevel.js'

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
/**
 * Against the model's whole window, with the context limit marked on it. The
 * same reading the banner over the composer uses (contextLevel.ts).
 */
const level = useContextLevel(computed(() => props.session))
const pct = computed(() => level.value?.pct ?? 0)
const compactAt = computed(() => level.value?.compactAt ?? null)
/** Amber once a compaction is near, or the window itself is crowded. */
const crowded = computed(() => level.value?.warn ?? false)

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

/* ── what fills it ─────────────────────────────────────────────────────────
 *
 * The engine's own itemisation (`agent.context`), asked for when the panel
 * opens and again whenever a turn has brought a newer one. Not pushed with the
 * conversation: the parts run to a hundred MCP tools. */
const breakdown = ref<ContextBreakdown | null>(null)
async function loadBreakdown(): Promise<void> {
  if (!u.value?.breakdownAt) return void (breakdown.value = null)
  if (breakdown.value?.at === u.value.breakdownAt) return
  const id = props.session.id
  const b = await client.call('agent.context', { sessionId: id }).catch(() => null)
  if (props.session.id === id) breakdown.value = b
}

/** The section stays as it was left, across conversations and restarts. */
const KEY = 'cockpit.contextBreakdown'
const showParts = ref(localStorage.getItem(KEY) === 'open')
watch(showParts, (v) => localStorage.setItem(KEY, v ? 'open' : 'closed'))
/** Which categories are opened into their parts; not remembered. */
const opened = ref(new Set<string>())
function toggle(id: string): void {
  const next = new Set(opened.value)
  if (!next.delete(id)) next.add(id)
  opened.value = next
}

/**
 * Three hues for what a person can act on (the conversation itself, the
 * built-in tools, the MCP servers), one neutral for the rest: the same choice
 * the engine's own `/context` makes, so the two read alike.
 */
const HUE: Record<string, string> = {
  messages: 'var(--accent)',
  system_tools: 'var(--info)',
  mcp_tools: 'var(--ok)',
}
const hue = (id: string): string => HUE[id] ?? 'var(--text-dim)'

/** The engine's names, said the way the rest of the window says things. */
const NAMES: Record<string, string> = {
  autocompact_buffer: 'Held for compacting',
  // The engine's free space ends where it compacts, not at the window's edge.
  free_space: 'Room before compacting',
}
const nameOf = (c: { id: string; name: string }): string => NAMES[c.id] ?? c.name.replace(/\s*\(deferred\)$/i, '')

const rows = computed(() => {
  const b = breakdown.value
  if (!b) return null
  // Against the model's window, like the number and the bar above. Not the
  // engine's `max`: under a context limit that is the limit, and every share
  // came out two and a half times too big on a 400k limit.
  const max = u.value?.contextWindow || b.max || 1
  const row = (c: ContextBreakdown['categories'][number]) => ({
    ...c,
    label: nameOf(c),
    share: c.tokens / max,
    parts: b.parts[c.id] ?? [],
  })
  const cats = b.categories.filter((c) => c.tokens > 0)
  return {
    used: cats.filter((c) => c.kind === 'used').sort((a, z) => z.tokens - a.tokens).map(row),
    room: cats.filter((c) => c.kind === 'buffer' || c.kind === 'free').map(row),
    later: cats.filter((c) => c.kind === 'deferred').sort((a, z) => z.tokens - a.tokens).map(row),
  }
})

/** One decimal under 10%, none above: "0.7%", "7.7%", "80%". */
function share(x: number): string {
  const p = x * 100
  return (p < 10 ? p.toFixed(1) : Math.round(p)) + '%'
}

/** "Opus 5.5" rather than the engine's id; the id itself when the table does not know it. */
const modelName = computed(() => {
  const id = u.value?.model ?? ''
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id.replace(/^claude-/, '')
})

/**
 * The one sentence under the bar: how far the engine is from compacting, or,
 * with no compaction point, how much room is left.
 */
const status = computed(() => {
  const l = level.value
  if (!l) return ''
  if (l.compactAt !== null) return k(l.toCompact ?? 0) + ' left before it compacts at ' + k(l.compactAt)
  if (l.crowded) return 'Past ' + CROWDED + '%, answers get worse from here'
  return k(Math.max(0, l.window - l.tokens)) + ' free'
})

/** The last turn's token figures, for the tooltip on its row. */
const turnTokens = computed(() => {
  const t = turn.value?.usage
  return t ? k(t.input) + ' in, ' + k(t.output) + ' out, ' + k(t.cacheCreation) + ' written to cache' : ''
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

/** Where the engine compacts, as a share of the window, for the marks. */
const markAt = computed(() => (compactAt.value && u.value?.contextWindow ? compactAt.value / u.value.contextWindow : null))
/** Half the tick's length: the ring's own stroke, so it marks the ring without breaking its outline. */
const TICK = 1.25
/** A short radial tick across the ring at the compaction point. */
const tick = computed(() => {
  if (markAt.value === null) return null
  const a = markAt.value * 2 * Math.PI
  const at = (r: number) => ({ x: 8 + r * Math.sin(a), y: 8 - r * Math.cos(a) })
  const i = at(R - TICK)
  const o = at(R + TICK)
  return { x1: i.x, y1: i.y, x2: o.x, y2: o.y }
})

const title = computed(() => {
  if (!u.value) return ''
  const near = level.value?.nearCompact && level.value.toCompact !== null
  return k(u.value.contextTokens) + ' of ' + k(u.value.contextWindow) + ' tokens in context'
    + (compactAt.value ? ', compacts at ' + k(compactAt.value) : '')
    + (near ? ' (' + k(level.value!.toCompact!) + ' left)' : '')
    + ' · ' + money(u.value.costUsd) + ' so far'
})

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
    void loadBreakdown()
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
watch(() => [u.value?.breakdownAt, props.session.id], () => {
  if (open.value) void loadBreakdown()
  else breakdown.value = null
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
      :title="title"
      @click="open = !open"
    >
      <svg class="ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="track" cx="8" cy="8" :r="R" />
        <circle class="fill" cx="8" cy="8" :r="R" :stroke-dasharray="dash" />
        <line v-if="tick" class="tick" v-bind="tick" />
      </svg>
      <span class="num">{{ pct }}%</span>
      <span class="num cost">{{ money(u.costUsd) }}</span>
    </button>

    <!-- Upward and to the right: the composer sits at the foot of the window,
         and this is the last control in its row. -->
    <div v-if="open" class="panel">
      <header class="head">
        <span class="ttl">Context</span>
        <span v-if="modelName" class="model">{{ modelName }}</span>
      </header>

      <div class="body">
        <div class="level">
          <span class="big">{{ k(u.contextTokens) }}</span>
          <span class="of">of {{ k(u.contextWindow) }}</span>
          <span class="pct" :class="{ crowded }">{{ pct }}%</span>
        </div>

        <div v-if="seg" class="bar">
          <template v-if="rows">
            <i
              v-for="c in rows.used"
              :key="c.id"
              class="s"
              :style="{ width: c.share * 100 + '%', background: hue(c.id) }"
              :title="c.label + ', ' + k(c.tokens)"
            />
          </template>
          <template v-else>
            <i class="s cached" :style="{ width: seg.w(seg.cached) }" :title="k(seg.cached) + ' read back from cache'" />
            <i class="s fresh" :style="{ width: seg.w(seg.fresh) }" :title="k(seg.fresh) + ' new this turn'" />
          </template>
          <i
            v-if="markAt !== null"
            class="mark"
            :class="{ crowded }"
            :style="{ left: markAt * 100 + '%' }"
            :title="'Compacts at ' + k(compactAt ?? 0)"
          />
        </div>

        <p class="status" :class="{ crowded }">{{ status }}</p>
      </div>

      <section v-if="rows" class="parts">
        <button class="disc" :aria-expanded="showParts" @click="showParts = !showParts">
          <ChevronRight class="chev" :class="{ down: showParts }" />
          What fills it
        </button>

        <div v-if="showParts" class="list">
          <template v-for="group in [rows.used, rows.room]" :key="group === rows.used ? 'used' : 'room'">
            <div v-if="group === rows.room" class="gap" />
            <template v-for="c in group" :key="c.id">
              <component
                :is="c.parts.length ? 'button' : 'div'"
                class="row"
                :class="{ room: c.kind !== 'used', open: opened.has(c.id), more: c.parts.length }"
                @click="c.parts.length && toggle(c.id)"
              >
                <i class="sw" :class="{ hollow: c.kind !== 'used' }" :style="c.kind === 'used' ? { background: hue(c.id) } : {}" />
                <span class="nm">{{ c.label }}</span>
                <ChevronRight v-if="c.parts.length" class="chev sm" :class="{ down: opened.has(c.id) }" />
                <span class="tk">{{ k(c.tokens) }}</span>
                <span class="pc">{{ share(c.share) }}</span>
              </component>
              <ul v-if="opened.has(c.id)" class="sub">
                <li v-for="x in c.parts" :key="x.name + (x.detail ?? '')" :title="x.detail">
                  <span class="nm">{{ x.name }}</span>
                  <span class="tk">{{ k(x.tokens) }}</span>
                </li>
              </ul>
            </template>
          </template>

          <template v-if="rows.later.length">
            <p class="cap" title="Known to the agent by name only, loaded when it needs one">Loaded when needed</p>
            <template v-for="c in rows.later" :key="c.id">
              <component
                :is="c.parts.length ? 'button' : 'div'"
                class="row room"
                :class="{ open: opened.has(c.id), more: c.parts.length }"
                @click="c.parts.length && toggle(c.id)"
              >
                <i class="sw hollow" />
                <span class="nm">{{ c.label }}</span>
                <ChevronRight v-if="c.parts.length" class="chev sm" :class="{ down: opened.has(c.id) }" />
                <span class="tk">{{ k(c.tokens) }}</span>
                <span class="pc" />
              </component>
              <ul v-if="opened.has(c.id)" class="sub">
                <li v-for="x in c.parts" :key="x.name + (x.detail ?? '')" :title="x.detail">
                  <span class="nm">{{ x.name }}</span>
                  <span class="tk">{{ k(x.tokens) }}</span>
                </li>
              </ul>
            </template>
          </template>
        </div>
      </section>

      <dl class="facts">
        <dt>Spent</dt>
        <dd>
          <b>{{ money(u.costUsd) }}</b>
          <span>{{ session.turns }} turn{{ session.turns === 1 ? '' : 's' }}</span>
        </dd>
        <template v-if="turn?.usage">
          <dt>Last turn</dt>
          <dd :title="turnTokens">
            <b>{{ money(turn.usage.costUsd) }}</b>
            <span v-if="turn.endedAt">{{ secs(turn.startedAt, turn.endedAt) }}, {{ ago(turn.endedAt) }}</span>
          </dd>
        </template>
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
/* The compaction point: a hairline across the ring, quiet until it is near. */
.tick { stroke: var(--text-muted); stroke-width: 1.2; stroke-linecap: round; }
.trigger.crowded .tick { stroke: var(--warn); }

/* ── the panel ──────────────────────────────────────────────────────────
   Drawn like the other popovers (the ticket card): a header row on a hairline,
   then the one number that matters large, the bar under it, and the money last. */
.panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 60;
  width: 300px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--overlay);
  box-shadow: var(--shadow-md);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line-overlay);
}
.ttl { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.model { margin-left: auto; font-size: var(--fs-xs); color: var(--text-dim); }

.body { padding: 14px 14px 12px; }

.level { display: flex; align-items: baseline; gap: 6px; }
.big { font-size: 22px; font-weight: 640; letter-spacing: -0.02em; line-height: 1; color: var(--text); }
.of { font-size: var(--fs-sm); color: var(--text-dim); }
.pct { margin-left: auto; font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }
.pct.crowded { color: var(--warn); }

/* The whole window, left to right; free space is the track, not a segment. */
.bar {
  position: relative;
  display: flex;
  height: 6px;
  margin: 12px 0 9px;
  border-radius: 3px;
  background: var(--line-strong);
}
.s { display: block; height: 100%; transition: width var(--dur-3) var(--ease-soft); }
/* Rounded by hand rather than clipped: the compaction mark stands out of it. */
.s:first-child { border-radius: 3px 0 0 3px; }
.s.cached { background: var(--info); }
.s.fresh { background: var(--accent); }
.mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--text-muted);
}
.mark.crowded { background: var(--warn); }

.status { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }

/* ── what fills it ───────────────────────────────────────────────────────── */
.parts { border-top: 1px solid var(--line-overlay); }
.disc {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  padding: 0 14px 0 10px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-align: left;
}
.disc:hover { color: var(--text); }
.chev { width: 14px; height: 14px; flex: none; color: var(--text-dim); transition: transform var(--dur-1) var(--ease-soft); }
.chev.sm { width: 12px; height: 12px; }
.chev.down { transform: rotate(90deg); }

/* Scrolls on its own: a category opened into a hundred MCP tools must not
   push the money off the panel. */
.list {
  max-height: min(46vh, 360px);
  overflow-y: auto;
  padding: 0 6px 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: left;
}
.row.more:hover, .row.open { background: var(--hover); color: var(--text); }
.row.room { color: var(--text-dim); }
.sw { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.sw.hollow { box-shadow: inset 0 0 0 1.5px var(--line-strong); }
.row .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .chev { margin-left: -4px; }
.tk { margin-left: auto; color: var(--text); font-weight: 550; }
.row.room .tk { color: var(--text-dim); font-weight: 400; }
.pc { width: 38px; flex: none; text-align: right; color: var(--text-dim); }
.gap { height: 6px; }
.cap {
  margin: 8px 8px 2px;
  font-size: 11px;
  color: var(--text-dim);
}
.sub {
  margin: 2px 0 4px;
  padding: 0 0 0 23px;
  list-style: none;
}
.sub li {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 21px;
  padding-right: 54px;
  font-size: 11px;
  color: var(--text-dim);
}
.sub .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub .tk { color: var(--text-muted); font-weight: 400; }
.status.crowded { color: var(--warn); }

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  padding: 11px 14px 12px;
  border-top: 1px solid var(--line-overlay);
  font-size: var(--fs-xs);
}
.facts dt { color: var(--text-dim); }
.facts dd { display: flex; align-items: baseline; gap: 8px; margin: 0; min-width: 0; color: var(--text-dim); }
.facts b { font-weight: 600; color: var(--text); }
</style>
