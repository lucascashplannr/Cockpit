<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { runCommandNow, state } from '../core/store.js'

/**
 * §8 — the questions a declared command asks, before it runs.
 *
 * The line is shown with its placeholders still standing, and it is shown
 * *while* you answer: `pnpm release {{version}}` above a field labelled
 * "Version number" says where the answer is going better than any wording
 * could. That is §3.7's rule reaching the one surface that never had it —
 * nothing runs before you have seen what runs.
 *
 * A command with nothing to ask never opens this box; it simply runs. A
 * dialog that appears to say "about to do the thing you just clicked" is a
 * click, not a safeguard.
 */

const c = computed(() => state.pendingCommand)
const box = ref<HTMLElement | null>(null)
const busy = ref(false)

/** Every question answered — an empty field is not an answer. */
const ready = computed(
  () => !!c.value && c.value.command.inputs.every((i) => (c.value!.answers[i.key] ?? '').trim()),
)

/** The line as it will be, so the box shows the act and not the template. */
const preview = computed(() => {
  const p = c.value
  if (!p) return ''
  return p.command.cmd.replace(/\{\{([\w.-]+)\}\}/g, (whole, key: string) => {
    const a = (p.answers[key] ?? '').trim()
    return a || whole
  })
})

function close(): void {
  state.pendingCommand = null
}

async function go(): Promise<void> {
  const p = c.value
  if (!p || !ready.value || busy.value) return
  busy.value = true
  await runCommandNow(p.command, p.answers)
  busy.value = false
  close()
}

/**
 * The first field takes focus, found in the DOM rather than held in a ref.
 *
 * A `:ref` callback on a `v-for` also fires while the box is being torn down,
 * and anything it reads off the question is null by then — which is how the
 * first version of this threw a render error the moment a command ran.
 */
function focusFirst(): void {
  box.value?.querySelector<HTMLInputElement>('input.input')?.focus()
}

watch(c, async (v) => {
  if (!v) return
  await nextTick()
  focusFirst()
})
onMounted(async () => {
  await nextTick()
  focusFirst()
})

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <div v-if="c" class="scrim" @keydown="onKey" @mousedown.self="close">
    <div ref="box" class="dlg" role="dialog" aria-modal="true">
      <header class="head">
        <h2>{{ c.command.name }}</h2>
        <span class="grow" />
        <button class="icon-btn" title="Close (esc)" @click="close"><X class="sm" /></button>
      </header>

      <div class="body">
        <!-- Where, before what: the same command is a different act in a topic
             and on main, and the folder is the only thing that says which. -->
        <p class="where">
          in <code class="mono">{{ c.command.cwd.split('/').slice(-2).join('/') }}</code>
          <span v-if="c.command.fellBack" class="dim"> — the main checkout, not this branch</span>
        </p>

        <code class="mono line selectable">{{ preview }}</code>

        <label v-for="i in c.command.inputs" :key="i.key" class="field">
          <span class="lbl">{{ i.label }}</span>
          <input
            v-model="c.answers[i.key]"
            class="input"
            :placeholder="'{{' + i.key + '}}'"
            @keydown.enter="go"
          />
        </label>

        <p v-if="c.command.confirm" class="ask">{{ c.command.confirm }}</p>
      </div>

      <footer class="foot">
        <span class="grow" />
        <button class="btn ghost" @click="close">Cancel</button>
        <button class="btn primary" :disabled="!ready || busy" @click="go">
          {{ busy ? 'Running…' : 'Run' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dlg {
  width: min(480px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 6px 20px;
}
.head h2 { margin: 0; font-size: var(--fs-md); font-weight: 640; letter-spacing: -0.01em; }
.grow { flex: 1; }
.body { flex: 0 1 auto; min-height: 0; overflow-y: auto; padding: 4px 20px 12px; }
.where { margin: 0 0 8px; font-size: var(--fs-xs); color: var(--text-muted); }
/* The line reads as the thing about to happen, so it gets the sunken fill the
   app already uses for "this is content, not chrome". */
.line {
  display: block;
  padding: 9px 12px;
  margin-bottom: 16px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.field { display: block; margin-bottom: 14px; }
.lbl { display: block; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 6px; }
.ask { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.dim { color: var(--text-dim); }
.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 14px;
}
</style>
