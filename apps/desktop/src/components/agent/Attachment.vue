<script setup lang="ts">
import { computed, watch } from 'vue'
import { FileText } from '@lucide/vue'
import type { Attachment } from '@cockpit/shared'
import { attachmentSrc, attachmentText, loadAttachment, state } from '../../core/store.js'

/**
 * One file, as it appears in a turn that has already been sent.
 *
 * The bytes come back from the core rather than off a `file://` URL: the
 * window is served over http in development, and the page's CSP allows `self`
 * and `data:` and nothing else, so a thumbnail that only worked in a release
 * build is one nobody would see until it was too late to notice.
 *
 * They land in the store rather than here, so that the viewer this tile opens
 * can be handed the whole turn's pictures without every tile passing its own
 * bytes up through an event.
 */
const props = defineProps<{
  file: Attachment
  /**
   * What the message calls this one — `#header-today`, or `all` when nothing
   * points at it.
   *
   * Absent when the turn anchors nothing at all, which is most turns: a row of
   * tiles each labelled `all` says only that no distinction is being drawn,
   * and says it five times.
   */
  label?: string
}>()

const src = computed(() => attachmentSrc(props.file.path))
/** A folded paste shows its opening lines, the way a picture shows itself. */
const text = computed(() => (props.file.pasted ? attachmentText(props.file.path) : ''))
const tip = computed(() =>
  text.value ? text.value.slice(0, 600) + (text.value.length > 600 ? '\n…' : '') : props.file.name,
)

/** Asked again whenever the socket comes back, not once on mount. */
watch(
  () => [state.connection, props.file.path] as const,
  () => void loadAttachment(props.file),
  { immediate: true },
)
</script>

<template>
  <li class="tile" :class="{ pic: file.image && src, text: file.pasted && text }" :title="tip">
    <img v-if="file.image && src" :src="src" :alt="file.name" />
    <pre v-else-if="file.pasted && text" class="snip">{{ text.slice(0, 400) }}</pre>
    <template v-else>
      <FileText class="glyph" />
      <span class="fname">{{ file.name }}</span>
    </template>
    <!-- Which tag in the sentence above is this one. Five screenshots pasted
         out of a clipboard are all called `image.png`, so the handle is the
         only thing that tells them apart — on the tile, because that is what
         you look at when you are matching a tag to a picture. -->
    <span v-if="label" class="tok">{{ label }}</span>
  </li>
</template>

<style scoped>
/* One square, whatever is in it.
   A file used to be a 26px pill beside 84px pictures, so a turn carrying both
   read as two lists that had been pushed together — the pill floating at the
   top of a row it did not belong to. What is attached is one kind of thing;
   the tile is the same size for all of it, and only the contents differ. */
.tile {
  position: relative;
  width: 84px;
  height: 84px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel-raised);
  color: var(--text-muted);
  overflow: hidden;
}
/* An image fills its tile edge to edge; one whose bytes never arrived falls
   back to the same treatment a file gets, which is why that is a fallback
   rather than a broken picture. */
.tile.pic {
  padding: 0;
  /* The tile is an index, not the picture: this says the picture is one click
     away, on the only ones where that is true. */
  cursor: zoom-in;
}
/* Pasted text reads from the top-left like the page it came from, and simply
   runs out at the bottom of the square. */
.tile.text { align-items: stretch; justify-content: flex-start; padding: 6px 7px; }
.snip {
  margin: 0;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 7.5px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
  -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}
.tile.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* The same label the composer puts on a tile, for the same reason. */
.tok {
  position: absolute;
  left: 3px;
  bottom: 3px;
  max-width: calc(100% - 6px);
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 620;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* An icon, not a picture. At 26px the glyph *was* the tile and the name read
   as a footnote to it; at this size the two share the square — the glyph says
   "a file", the name says which one. The tile is unchanged at 84px either
   way: this is the mark shrinking, not the card.

   `--ic-lg` rather than a number: the app has three icon sizes and a fourth
   invented for one component is how a scale stops being one. */
.glyph { width: var(--ic-lg); height: var(--ic-lg); flex: none; color: var(--text-dim); }

/* Two lines, then the ellipsis. A tile is 72px of usable width, so one line
   would cut `.prettierrc` in half; the tooltip carries the whole name either
   way. Centred, because the icon above it is. */
.fname {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  text-align: center;
  font-size: 10px;
  line-height: 1.3;
  word-break: break-all;
}
</style>
