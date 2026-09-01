<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Ellipsis } from '@lucide/vue'

/**
 * The rest of the verbs.
 *
 * The bars for a repository and for a topic each held five or six acts drawn
 * as bare icons at one weight, which is how a header stops being readable: the
 * eye has nothing to rank and has to hover every one of them to find out what
 * they are. The rule now is that the bar shows the verbs the *state* calls for
 * — Push while there is something to push, Rebase while it is behind — and
 * everything the thing can do is here, named, always in the same order.
 *
 * Deliberately not a `<select>` or a native context menu: those cannot carry
 * an icon, a keystroke and a disabled reason, and every one of these acts has
 * at least two of the three.
 */

const props = defineProps<{ label?: string; disabled?: boolean }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

/** Anywhere outside, including inside another menu's button, closes it. */
function onDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

/**
 * Captured, and the event stopped dead: Escape walks the whole shell back
 * layer by layer (App.vue's `onKey`, on this same window), and an open menu is
 * the innermost layer there is. Without this it would take the review column
 * down with it, from under a menu floating on top of that column.
 *
 * Both handlers sit on `window`, so which one wins is a matter of phase: a
 * real keystroke targets whatever has focus, this listener sees it on the way
 * down, and stopping it there means it never reaches the node to bubble back
 * up to App.vue's. `stopImmediatePropagation` rather than the plain form
 * because that one leaves listeners on the *same* node alone.
 *
 * Worth knowing when testing this: an Escape *dispatched on `window` itself*
 * is at-target for both, where listeners run in registration order — App.vue's
 * was registered first and runs anyway. Dispatch on `document.body` to
 * reproduce a keystroke.
 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopImmediatePropagation()
    open.value = false
  }
}

/** Losing the verbs while they are unavailable also closes the list of them. */
watch(() => props.disabled, (d) => { if (d) open.value = false })

onMounted(() => {
  document.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDown)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div ref="root" class="more">
    <button
      class="icon-btn mb"
      :class="{ on: open }"
      :disabled="disabled"
      :title="label ?? 'Everything else you can do here'"
      @click="open = !open"
    >
      <Ellipsis class="sm" />
    </button>
    <!-- Any click inside picks something, so any click inside closes it. -->
    <div v-if="open" class="menu" @click="open = false"><slot /></div>
  </div>
</template>

<style scoped>
.more { position: relative; flex: none; }
.mb { width: 26px; height: 26px; }
/* Under its own button and against the right edge of the window, because the
   bar it hangs from is always at the top of a column and always near it. */
.menu { top: calc(100% + 5px); right: 0; }
</style>
