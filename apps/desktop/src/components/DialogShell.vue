<script setup lang="ts">
import { X } from '@lucide/vue'

/**
 * The chrome every dialog in this window already has, in one place.
 *
 * It was in thirteen places, copied, and that is exactly how a fourteenth
 * arrives looking like nothing else: the `servers and commands` sheet was
 * written from `ConfirmDialog`'s numbers — a question's numbers — and so had
 * no rule under its title, a smaller heading and a footer that did not sit in
 * its own well. Nothing about it was wrong on its own; it simply was not the
 * same dialog as the others.
 *
 * Two variants, because the window has two and always did:
 *
 * - `sheet` — a workbench. 560px, a rule under the head, a footer in
 *   `--bg-sunken`, `--fs-lg` title. What Topic, Project and Settings use.
 * - `question` — a decision. 480px, no rules, `--fs-md` title, the buttons
 *   sitting straight on the card. What Confirm uses.
 */

const props = withDefaults(
  defineProps<{
    title: string
    variant?: 'sheet' | 'question'
    /** Overrides the variant's own width, for the rare dialog that needs it. */
    width?: number
    /** Escape and a click outside close it; off while something is in flight. */
    dismissible?: boolean
    /**
     * What Escape does, when it is not simply close: a sheet stepped into
     * from another peels back to it. A prop rather than an emit so its
     * absence can be seen.
     */
    onEscape?: () => void
  }>(),
  { variant: 'sheet', width: 0, dismissible: true },
)

const emit = defineEmits<{ close: [] }>()

/**
 * Stopped here: the window's own Escape ladder runs after this one, and a key
 * that already closed this sheet would otherwise close whatever is under it.
 */
function onEsc(): void {
  if (!props.dismissible) return
  if (props.onEscape) props.onEscape()
  else emit('close')
}
</script>

<template>
  <div
    class="scrim"
    @keydown.esc.stop="onEsc"
    @mousedown.self="dismissible && emit('close')"
  >
    <div
      class="dlg"
      :class="variant"
      :style="width ? { width: 'min(' + width + 'px, 94vw)' } : undefined"
      role="dialog"
      aria-modal="true"
    >
      <header class="head">
        <!-- Before the title: a back arrow, an icon, whatever the dialog leads with. -->
        <slot name="lead" />
        <!-- The title is a string for almost every dialog, and a string is
             what most of them want. The slot is for the one that needs the
             heading to be *composed* — an icon, a name and what it is scoped
             to — rather than a sentence with a middle dot in it. It keeps the
             h2, so the type and the clipping stay the shell's. -->
        <h2><slot name="title">{{ title }}</slot></h2>
        <span class="grow" />
        <slot name="head" />
        <button class="icon-btn" title="Close (esc)" @click="emit('close')"><X class="sm" /></button>
      </header>

      <div class="body"><slot /></div>

      <footer v-if="$slots.foot" class="foot"><slot name="foot" /></footer>
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
  max-height: 84vh;
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
.dlg.sheet { width: min(560px, 92vw); }
/* Narrower on purpose: it is a question, and a question the width of a
   terminal reads as a report. */
.dlg.question { width: min(480px, 92vw); max-height: 80vh; }

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 14px 14px 20px;
}
.sheet .head { border-bottom: 1px solid var(--line); }
.question .head { padding-bottom: 6px; }
.head h2 {
  margin: 0;
  min-width: 0;
  font-weight: 640;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet .head h2 { font-size: var(--fs-lg); }
.question .head h2 { font-size: var(--fs-md); }
/* Composed titles lay themselves out; `overflow: hidden` on the h2 still
   clips them, and whichever part they mark as flexible is the part that goes. */
.head h2:has(> *) { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px 6px; }
.question .body { flex: 0 1 auto; padding: 4px 20px 12px; }

.foot { flex: none; display: flex; align-items: center; gap: 9px; padding: 13px 16px; }
.sheet .foot { border-top: 1px solid var(--line); background: var(--bg-sunken); }
.question .foot { padding: 10px 16px 14px; }
</style>
