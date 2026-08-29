<script setup lang="ts">
import { computed } from 'vue'
import { GitBranch, Layers } from '@lucide/vue'
import { activeProject, activeWorkspace, selectedFeatureGroup } from '../core/store.js'

/**
 * What the window is currently about.
 *
 * A title bar is for the thing you are looking at, which is why the mark left
 * it for the rail: the verbs on the right of the band act on this workspace,
 * and without its name beside them they read as applying to nothing.
 *
 * The project always leads, so the crumb has the same shape on every row. It
 * used to be dropped whenever the two names matched, which looked tidy on a
 * mono-repo and reads as a bug now: a project's first repository is usually
 * called after the folder that holds it, so one row in the list showed one
 * segment while its siblings showed two, and nothing on screen said why.
 *
 * The one exception is the workspace that *is* the project — the root folder
 * holding the others. There the names are not merely equal, they are the same
 * thing, and a crumb from something to itself says nothing.
 */

const w = computed(() => activeWorkspace.value)
const project = computed(() => activeProject.value)

/**
 * A feature is selectable in the list, and the band is what the window is
 * about: while the feature is the selection, it is the feature that is named
 * here — otherwise the verbs beside it (FeatureActions) would read as acting
 * on whichever of its worktrees happened to be the anchor.
 */
const feature = computed(() => selectedFeatureGroup.value)
const showProject = computed(
  () => !!project.value && !!w.value && w.value.path !== project.value.root,
)
</script>

<template>
  <div v-if="feature" class="wsid">
    <span class="proj">{{ project?.name }}</span>
    <span class="sep">/</span>
    <h1 class="name">{{ feature.title }}</h1>
    <span class="chip"><Layers />feature</span>
    <span class="chip dim">{{ feature.workspaces.length }} worktree(s)</span>
  </div>

  <div v-else-if="w" class="wsid">
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
/* 15px rather than --fs-sm: at 13px against an 18px name the project read as
   a caption on the workspace instead of the first half of one crumb. Still a
   clear step below it, and the colour carries the rest of the hierarchy. */
.proj {
  flex: none;
  font-size: 15px;
  color: var(--text-dim);
}
.sep {
  flex: none;
  font-size: 15px;
  color: var(--text-dim);
  opacity: 0.6;
}
/* 18px/650 rather than 16px/620: in a 50px band the name is what anchors the
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
.wsid .chip.dim { color: var(--text-dim); }
</style>
