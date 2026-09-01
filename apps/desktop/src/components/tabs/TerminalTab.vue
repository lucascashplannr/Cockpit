<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Workspace } from '@cockpit/shared'
import { client, guard, onTermData, state } from '../../core/store.js'

/**
 * §2 — "Il en embarque un, indispensable comme porte de sortie."
 * A real TTY running the user's own shell; the cockpit never pretends to
 * replace it.
 */

const props = defineProps<{ workspace: Workspace }>()

const host = ref<HTMLElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const termId = ref<string | null>(null)
const error = ref<string | null>(null)
let unsubscribe: (() => void) | null = null
let ro: ResizeObserver | null = null

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * A colour token, as a colour.
 *
 * This is why the shell came up in white on the light theme. A custom property
 * is *substituted*, not resolved: `getPropertyValue('--text')` hands back the
 * literal string `light-dark(#16161c, #ecedf3)`, which is a perfectly good CSS
 * value and not a colour xterm can parse. It fell back to its own palette —
 * white on black — and `.xterm-viewport { background: transparent }` hid the
 * black half, leaving white text on the app's light ground.
 *
 * Reading it back off a real element makes the browser do the resolving, which
 * is the only thing that can: `light-dark()` needs the `color-scheme` in force
 * at that point in the tree, and the tokens are written as one palette in
 * light-dark pairs on purpose (tokens.css). The probe goes in the body so it
 * inherits the same scheme the app is drawn in.
 */
function readColor(name: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${name})`
  document.body.appendChild(probe)
  const v = getComputedStyle(probe).color
  probe.remove()
  return v || fallback
}

/** The four colours xterm is told about, read fresh from the tokens. */
function palette() {
  return {
    background: readColor('--bg', '#0c0c0f'),
    foreground: readColor('--text', '#16161c'),
    cursor: readColor('--accent', '#5b58e0'),
    selectionBackground: readColor('--accent-soft', 'rgba(91,88,224,0.16)'),
  }
}

async function boot() {
  await teardown()
  const el = host.value
  if (!el) return

  const t = new Terminal({
    fontFamily: readVar('--mono', 'monospace'),
    fontSize: 13,
    lineHeight: 1.45,
    cursorBlink: true,
    allowProposedApi: true,
    theme: palette(),
  })
  const f = new FitAddon()
  t.loadAddon(f)
  t.open(el)
  f.fit()
  term.value = t
  fit.value = f

  const res = await guard(() =>
    client.call('terminal.open', {
      workspaceId: props.workspace.id,
      cols: t.cols,
      rows: t.rows,
    }),
  )
  if (!res) {
    error.value = 'Could not open a terminal (node-pty unavailable in the core).'
    return
  }
  termId.value = res.termId
  unsubscribe = onTermData(res.termId, (d) => t.write(d))

  t.onData((d) => {
    if (termId.value) void client.call('terminal.write', { termId: termId.value, data: d })
  })

  ro = new ResizeObserver(() => {
    try {
      f.fit()
      if (termId.value) {
        void client.call('terminal.resize', { termId: termId.value, cols: t.cols, rows: t.rows })
      }
    } catch {
      /* element detached */
    }
  })
  ro.observe(el)
}

async function teardown() {
  ro?.disconnect()
  ro = null
  unsubscribe?.()
  unsubscribe = null
  if (termId.value) {
    const id = termId.value
    termId.value = null
    await client.call('terminal.close', { termId: id }).catch(() => undefined)
  }
  term.value?.dispose()
  term.value = null
}

/**
 * The appearance changing repaints the shell in place.
 *
 * Two sources, because there are two ways it changes: the setting in the rail,
 * and — while that setting is 'system' — the OS deciding it is evening. The
 * terminal is the one surface in the window that does not get this for free:
 * everything else is CSS and re-resolves itself, while xterm was handed four
 * colours once at boot and would have kept them until the tab was closed.
 */
const scheme = window.matchMedia('(prefers-color-scheme: dark)')
function repaint() {
  const t = term.value
  if (t) t.options.theme = palette()
}
scheme.addEventListener('change', repaint)

onMounted(boot)
onBeforeUnmount(() => {
  scheme.removeEventListener('change', repaint)
  void teardown()
})
watch(() => props.workspace.id, () => void boot())
// After the attribute lands on the root, not with it: `palette()` reads the
// scheme in force, and reading it in the same tick as the change gets the old
// one back.
watch(() => state.theme, () => void nextTick(repaint))
</script>

<template>
  <div class="wrap">
    <div v-if="error" class="empty"><strong>Terminal unavailable</strong><span>{{ error }}</span></div>
    <div ref="host" class="term" />
  </div>
</template>

<style scoped>
.wrap { height: 100%; padding: 14px 8px 8px 16px; background: var(--bg); }
.term { height: 100%; }
:deep(.xterm) { height: 100%; }
:deep(.xterm-viewport) { background: transparent !important; }
</style>
