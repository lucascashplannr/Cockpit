<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight, X } from '@lucide/vue'
import { state, stepImage } from '../core/store.js'

/**
 * The picture, at the size it was worth attaching.
 *
 * A 48-pixel tile in the composer and an 84-pixel one in the thread say *that*
 * a screenshot is there; neither lets anyone read the error message inside it.
 * This is where it is actually looked at.
 *
 * Deliberately not a dialog: there is no decision here and so there are no
 * buttons to weigh. A scrim, the image, its name, and every way out you would
 * try without being told — Escape, the ✕, a click on the space around it.
 *
 * The name sits *under* the picture, and that is not a taste decision: this
 * app draws its own traffic lights, fixed at (10, 19) and floating above
 * everything including this scrim, so a title in the top-left corner is a
 * title with three coloured circles through it. The corner belongs to them.
 *
 * Escape is handled in `App.vue` with the rest of the layers rather than
 * captured here, so the order things close in stays written down in one place.
 */
const v = computed(() => state.pendingImage)
const shown = computed(() => v.value?.items[v.value.at] ?? null)
const many = computed(() => (v.value?.items.length ?? 0) > 1)

function close(): void {
  state.pendingImage = null
}
</script>

<template>
  <!-- `mousedown.self`, matching the dialogs: a drag that starts on the image
       and ends on the scrim is someone selecting or dragging the picture, not
       someone asking to close it. It also means a click anywhere on the
       picture or its caption does nothing, which is what those are for. -->
  <div v-if="v && shown" class="scrim" @mousedown.self="close" @wheel.prevent>
    <!-- Opposite corner from the lights, which is the only free one. -->
    <button class="icon-btn out" title="Close — or press Escape" @click="close">
      <X class="sm" />
    </button>

    <!-- One step per press and wrapping, because a pair of screenshots is a
         thing you flick between rather than navigate. -->
    <button v-if="many" class="step back" title="Previous" @click="stepImage(-1)">
      <ChevronLeft class="md" />
    </button>

    <figure class="frame">
      <!-- Keyed on the source: swapping images must replace the element rather
           than repoint it, or the browser holds the old frame while the new
           one decodes and the step looks like it did nothing. -->
      <img :key="shown.src" class="shot" :src="shown.src" :alt="shown.name" />
      <figcaption class="cap">
        <span class="name">{{ shown.name }}</span>
        <span v-if="many" class="of">{{ v.at + 1 }} of {{ v.items.length }}</span>
      </figcaption>
    </figure>

    <button v-if="many" class="step fwd" title="Next" @click="stepImage(1)">
      <ChevronRight class="md" />
    </button>
  </div>
</template>

<style scoped>
/* Above the dialogs: it is opened from the thread, and whatever is under it
   stays exactly where it was. */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
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

.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin: 0;
  max-width: 92vw;
  min-width: 0;
}

/* Checkered would be honest about transparency and loud about it; a plain
   panel behind the image keeps a PNG with rounded corners legible in both
   themes without decorating the thing being looked at. */
.shot {
  max-width: 92vw;
  /* Room for the caption and the same air above the picture as below it. */
  max-height: calc(100vh - 96px);
  object-fit: contain;
  border-radius: var(--radius);
  background: var(--panel-raised);
  box-shadow: var(--shadow-lg);
}

/* Under the picture, and no band behind it: the scrim is already a surface,
   and a second one would frame the picture in furniture. */
.cap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  color: var(--text);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
}
.of { flex: none; font-size: var(--fs-xs); color: var(--text-dim); }

/* The scrim is not a panel, so `icon-btn`'s inherited colour lands a shade too
   faint on it — the one way out that is drawn rather than remembered should
   read at least as clearly as the caption under the picture. */
.out {
  position: fixed;
  top: 13px;
  right: 14px;
  color: var(--text-muted);
}
.out:hover { color: var(--text); }

.step {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  color: var(--text-muted);
  box-shadow: var(--shadow-sm);
}
.step:hover { color: var(--text); background: var(--hover); }
.step.back { left: 16px; }
.step.fwd { right: 16px; }
.md { width: 17px; height: 17px; }
</style>
