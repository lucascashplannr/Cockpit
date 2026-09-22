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
 *
 * Above the window, under anything laid over it. A dialog and the attachment
 * viewer are the same gesture — a sheet of blurred glass across the whole
 * window — and three coloured buttons drawn crisply on top of the blur were
 * the one part of the window the glass did not take, while the red one closed
 * the whole window from inside a preview. Sitting below the scrims, they blur
 * and dim along with the rail and the list, which is where the window has
 * gone; a click that lands on them lands on the scrim, and dismisses.
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
        <path d="M1.2 6.8 V3.9 L4.1 6.8 Z M6.8 1.2 V4.1 L3.9 1.2 Z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* The geometry the native buttons had: 10px in from the window's left edge,
   at the offset the window was told to expect (trafficLightPosition in
   main.cjs), 12px circles 8px apart. Fixed and above the start page, which
   covers the band the way it covers everything else.

   45 is above every view the window draws (the conversation drawer, at 41, is
   the highest) and below every scrim laid over it (the palette at 50, the
   menus at 55, the dialogs at 60, the viewer at 70). */
.lights {
  position: fixed;
  top: 19px;
  left: 10px;
  z-index: 45;
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

   8.5px inside a 12px circle. macOS draws these a shade smaller, but macOS
   draws them on its own titlebar, at the top of a screen you are looking at.
   Ours sit on a dark band you glance at from the editor, and at the native
   size the marks read as smudges rather than as verbs. Bigger and darker, then
   — far enough short of the edge that they are still symbols drawn in the
   light rather than badges stuck on it. */
.glyph {
  width: 8.5px;
  height: 8.5px;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
  stroke: rgba(0, 0, 0, 0.66);
  stroke-width: 1.3;
  stroke-linecap: round;
  fill: none;
}
.glyph.fill { fill: rgba(0, 0, 0, 0.66); stroke: none; }
.lights:hover .glyph { opacity: 1; }
</style>
