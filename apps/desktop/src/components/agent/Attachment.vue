<script setup lang="ts">
import { computed, watch } from 'vue'
import { FileText } from '@lucide/vue'
import type { Attachment } from '@cockpit/shared'
import { attachmentSrc, loadAttachment, state } from '../../core/store.js'

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
const props = defineProps<{ file: Attachment }>()

const src = computed(() => attachmentSrc(props.file.path))

/** Asked again whenever the socket comes back, not once on mount. */
watch(
  () => [state.connection, props.file.path] as const,
  () => void loadAttachment(props.file),
  { immediate: true },
)
</script>

<template>
  <li :class="{ pic: file.image && src }" :title="file.name">
    <img v-if="file.image && src" :src="src" :alt="file.name" />
    <template v-else>
      <FileText class="glyph" />
      <span class="fname">{{ file.name }}</span>
    </template>
  </li>
</template>

<style scoped>
/* One square, whatever is in it.
   A file used to be a 26px pill beside 84px pictures, so a turn carrying both
   read as two lists that had been pushed together — the pill floating at the
   top of a row it did not belong to. What is attached is one kind of thing;
   the tile is the same size for all of it, and only the contents differ. */
li {
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
li.pic {
  padding: 0;
  /* The tile is an index, not the picture: this says the picture is one click
     away, on the only ones where that is true. */
  cursor: zoom-in;
}
li.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }

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
