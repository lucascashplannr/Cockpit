<script setup lang="ts">
import { computed } from 'vue'
import { GitBranch } from '@lucide/vue'
import { activeProject, activeWorkspace } from '../core/store.js'

/**
 * What the window is currently about.
 *
 * A title bar is for the thing you are looking at, which is why the mark left
 * it for the rail: the verbs on the right of the band act on this workspace,
 * and without its name beside them they read as applying to nothing.
 *
 * The project name appears only when it differs from the workspace's — for a
 * main checkout the two are the same word and repeating it says nothing.
 */

const w = computed(() => activeWorkspace.value)
const project = computed(() => activeProject.value)
const showProject = computed(() => !!project.value && project.value.name !== w.value?.name)
</script>

<template>
  <div v-if="w" class="wsid">
    <template v-if="showProject">
      <span class="proj">{{ project?.name }}</span>
      <span class="sep">/</span>
    </template>
    <h1 class="name" :title="w.path">{{ w.name }}</h1>
    <span v-if="w.kind !== 'main'" class="chip"><GitBranch />{{ w.kind }}</span>
    <span v-if="w.git && w.git.headState !== 'attached'" class="chip danger">
      {{ w.git.headState }}
    </span>
  </div>
</template>

<style scoped>
.wsid {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  /* Stays draggable: the window is moved by its title bar, and nothing here
     is a control. */
}
.proj {
  flex: none;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.sep {
  flex: none;
  color: var(--text-dim);
  opacity: 0.6;
}
/* 18px/650 rather than 16px/620: in a 58px band the name is what anchors the
   left half against the verbs on the right, and at --fs-lg it was the same
   weight as body copy sitting in a lot of empty chrome. Between --fs-lg and
   --fs-xl on purpose — 20px starts competing with the app's own name. */
.name {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.015em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wsid .chip {
  align-self: center;
  height: 21px;
  font-size: 11px;
}
</style>
