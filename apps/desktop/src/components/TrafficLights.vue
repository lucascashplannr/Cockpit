<script setup lang="ts">
import { hostWindow } from '../core/store.js'

/**
 * The window's three buttons, drawn rather than native.
 *
 * AppKit greys the standard ones on any window that is not the key window, and
 * that state belongs to the window rather than to the buttons — there is no
 * flag to pass and nothing Electron can forward. Drawing them is the only way
 * they stay lit while the focus is somewhere else, which is most of the time
 * in a cockpit: you are in the editor, or the browser, and this window is what
 * you glance at.
 *
 * Everything else about them is macOS's: the same three colours, the same
 * 12px circles at the same offset, the glyphs appearing only on hover of the
 * group rather than of each button, and the same verb behind each one — green
 * is fullscreen, ⌥-green is the older zoom-to-fit.
 *
 * Fixed rather than laid out in the title band: the start page covers the
 * whole window, including the band, and native buttons used to float over it.
 * These have to as well, or the start page would have no way to close.
 */
</script>

<template>
  <div v-if="hostWindow" class="lights">
    <button class="lt close" title="Close" @click="hostWindow.close()">
      <svg class="glyph" viewBox="0 0 8 8" aria-hidden="true">
        <path d="M2.1 2.1 L5.9 5.9 M5.9 2.1 L2.1 5.9" />
      </svg>
    </button>
    <button class="lt min" title="Minimise" @click="hostWindow.minimize()">
      <svg class="glyph" viewBox="0 0 8 8" aria-hidden="true">
        <path d="M1.6 4 H6.4" />
      </svg>
    </button>
    <button
      class="lt zoom"
      title="Fullscreen — ⌥ to fit"
      @click="hostWindow.zoom($event.altKey)"
    >
      <svg class="glyph fill" viewBox="0 0 8 8" aria-hidden="true">
        <path d="M1.4 6.6 V4.4 L3.6 6.6 Z M6.6 1.4 V3.6 L4.4 1.4 Z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* The geometry the native buttons had: 10px in from the window's left edge,
   at the offset the window was told to expect (trafficLightPosition in
   main.cjs), 12px circles 8px apart. Fixed and
   above the start page, which covers the band the way it covers everything
   else. */
.lights {
  position: fixed;
  top: 19px;
  left: 10px;
  z-index: 200;
  display: flex;
  gap: 8px;
  /* The band under them drags the window; these are controls, not chrome. */
  -webkit-app-region: no-drag;
}

.lt {
  width: 12px;
  height: 12px;
  padding: 0;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* The ring is what keeps a light circle legible on a light band; macOS draws
     the same one, a shade of the fill rather than a grey. */
  border: 0.5px solid var(--ring);
  background: var(--fill);
  transition: filter var(--dur-1) var(--ease-soft);
}
.lt:hover { filter: brightness(0.94); }
.lt:active { filter: brightness(0.82); }

.close { --fill: #ff5f57; --ring: #e0443e; }
.min { --fill: #febc2e; --ring: #dea123; }
.zoom { --fill: #28c840; --ring: #1aab29; }

/* Hovering any one of them shows all three glyphs, as macOS does: they read as
   one control with three parts.

   6.5px inside a 12px circle, not 8: a mark that fills its button reads as a
   badge stuck on the light rather than a symbol drawn in it, and at this size
   the weight is what gives it away first — hence a stroke under a pixel once
   the 8-unit box is scaled down. */
.glyph {
  width: 6.5px;
  height: 6.5px;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
  stroke: rgba(0, 0, 0, 0.5);
  stroke-width: 1.1;
  stroke-linecap: round;
  fill: none;
}
.glyph.fill { fill: rgba(0, 0, 0, 0.5); stroke: none; }
.lights:hover .glyph { opacity: 1; }
</style>
