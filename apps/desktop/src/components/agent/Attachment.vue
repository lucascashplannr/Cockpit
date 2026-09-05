<script setup lang="ts">
import { ref, watch } from 'vue'
import { FileText } from '@lucide/vue'
import type { Attachment } from '@cockpit/shared'
import { client, state } from '../../core/store.js'

/**
 * One file, as it appears in a turn that has already been sent.
 *
 * The bytes come back from the core rather than off a `file://` URL: the
 * window is served over http in development, and a thumbnail that only worked
 * in a release build is one nobody would see until it was too late to notice.
 * Loaded on mount and per component, so a thread of forty turns fetches the
 * pictures of the turns that are actually on screen.
 */
const props = defineProps<{ file: Attachment }>()

const src = ref('')

/**
 * Asked again whenever the socket comes back, not once on mount.
 *
 * `client.call` refuses outright while the connection is down, so a thread
 * opened during a reconnect would have loaded nothing and then sat there
 * showing filenames for the rest of the session — a picture that is present,
 * addressable and simply never drawn. Watching the connection costs one line
 * and removes the whole failure.
 *
 * Failure is quiet on purpose: it is a thumbnail. A toast per image would turn
 * one dropped socket into eight red banners over a conversation.
 */
watch(
  () => [state.connection, props.file.path] as const,
  async () => {
    if (!props.file.image || src.value) return
    if (state.connection !== 'connected' && state.connection !== 'outdated') return
    try {
      const b64 = await client.call('agent.attachment', { path: props.file.path })
      // An attachment whose bytes are gone falls back to the chip: the name is
      // still true, and a broken image icon is worse than a filename.
      if (b64) src.value = 'data:' + props.file.mediaType + ';base64,' + b64
    } catch {
      /* the next connection will ask again */
    }
  },
  { immediate: true },
)
</script>

<template>
  <li :class="{ pic: file.image && src }" :title="file.name">
    <img v-if="file.image && src" :src="src" :alt="file.name" />
    <template v-else>
      <FileText class="sm" />
      <span class="fname">{{ file.name }}</span>
    </template>
  </li>
</template>

<style scoped>
li {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* An image that loaded is shown at a size worth looking at; one that did not
   is a chip with its name, which is the same thing a file gets. */
li.pic {
  width: 84px;
  height: 84px;
  padding: 0;
  overflow: hidden;
  border-radius: var(--radius);
}
li.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lucide { flex: none; color: var(--text-dim); }
.sm { width: 13px; height: 13px; }
</style>
