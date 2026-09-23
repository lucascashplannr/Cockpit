<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import DialogShell from './DialogShell.vue'
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
  document.querySelector<HTMLInputElement>('.scrim input.input')?.focus()
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
  <DialogShell
    v-if="c"
    :title="c.command.name"
    variant="question"
    :dismissible="!busy"
    @close="close"
  >
<!-- Where, before what: the same command is a different act in a topic
             and on main, and the folder is the only thing that says which.

             `fellBack` used to be said here too — "the main checkout, not
             this branch". It cannot happen any more: a command is offered
             only in the repository that declared it (`listCommands`), and
             there the environment always holds this very checkout, so the
             fallback it warned about is never the one taken. The flag stays
             on the type because servers still reach for it. -->
        <p class="where">
          in <code class="mono">{{ c.command.cwd.split('/').slice(-2).join('/') }}</code>
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

    <template #foot>
      <span class="grow" />
      <button class="btn ghost" @click="close">Cancel</button>
      <button class="btn primary" :disabled="!ready || busy" @click="go">
        {{ busy ? 'Running…' : 'Run' }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.grow { flex: 1; }
.field { display: block; margin-bottom: 14px; }
.lbl { display: block; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 6px; }
.ask { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.dim { color: var(--text-dim); }
</style>
