<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Workspace } from '@cockpit/shared'
import { client, guard, onTermData } from '../../core/store.js'

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
    theme: {
      background: readVar('--bg', '#0c0c0f'),
      foreground: readVar('--text', '#ececf1'),
      cursor: readVar('--accent', '#817fff'),
      selectionBackground: readVar('--accent-soft', 'rgba(129,127,255,0.16)'),
    },
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

onMounted(boot)
onBeforeUnmount(() => void teardown())
watch(() => props.workspace.id, () => void boot())
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
