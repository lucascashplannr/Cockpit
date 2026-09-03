<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BranchRef } from '@cockpit/shared'
import { ChevronDown, GitCompareArrows } from '@lucide/vue'
import { client, guard, replanBase, state } from '../core/store.js'

/**
 * §4 — catching up from a branch other than the usual one.
 *
 * The project's default branch is the answer nearly always, and it is a
 * setting because it is a standing fact about the project. This is the other
 * case: once, on purpose, from somewhere else — and the place to say so is the
 * question you are already being asked, which names the branch in its title.
 * No control on the bar, nothing to discover: the word you would want to
 * change is right there, and it is the word you press.
 *
 * Its own component because it is drawn wherever a Catch up is confirmed, and
 * one row that knows how to re-plan is better than two that nearly agree.
 *
 * Only a Catch up. Send to is the branch the work *belongs* to, and changing
 * that on the way past is a different decision.
 */

const from = computed(() => state.pendingPlanFrom)

const picking = ref(false)
const loading = ref(false)
const branches = ref<BranchRef[]>([])

/**
 * A base is a plain branch name — the steps say `git fetch origin <base>` and
 * rebase onto `origin/<base>` — so `origin/dev` and a local `dev` are one
 * entry here, not two. The current base is dropped: it is the word you pressed.
 */
const options = computed(() => {
  const seen = new Set<string>()
  const out: { name: string; subject: string }[] = []
  for (const b of branches.value) {
    const name = b.remoteOnly ? b.name.replace(/^[^/]+\//, '') : b.name
    if (name === from.value?.base || seen.has(name)) continue
    seen.add(name)
    out.push({ name, subject: b.subject })
  }
  return out
})

async function toggle() {
  picking.value = !picking.value
  if (!picking.value || !from.value?.workspaceId) return
  // §3.4 — read every time, never remembered: a branch made a minute ago in
  // the terminal is a legitimate thing to catch up from.
  loading.value = true
  branches.value =
    (await guard(() => client.call('git.branches', { workspaceId: from.value!.workspaceId }))) ?? []
  loading.value = false
}

async function pick(name: string) {
  picking.value = false
  await replanBase(name)
}
</script>

<template>
  <div v-if="from?.base" class="from">
    <GitCompareArrows class="sm si" />
    <span>from</span>
    <div class="pick">
      <button class="basebtn" :class="{ on: picking }" @click="toggle">
        <span>{{ from.base }}</span>
        <ChevronDown class="ch" />
      </button>
      <div v-if="picking" class="blist">
        <p v-if="loading" class="hint">Reading the branches…</p>
        <template v-else>
          <button v-for="b in options" :key="b.name" :title="b.subject" @click="pick(b.name)">
            {{ b.name }}
          </button>
          <p v-if="!options.length" class="hint">No other branch here.</p>
        </template>
      </div>
    </div>
    <span class="note">once — the project's default branch is unchanged</span>
  </div>
</template>

<style scoped>
.from {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.si { opacity: 0.8; }
.note { color: var(--text-dim); opacity: 0.75; }
.pick { position: relative; display: inline-flex; }
.basebtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-xs);
  font-family: var(--font);
}
.basebtn:hover, .basebtn.on { background: var(--hover); }
.basebtn .ch { width: 11px; height: 11px; opacity: 0.5; }
.blist {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 2;
  width: 260px;
  max-height: 240px;
  overflow: auto;
  padding: 5px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-lg);
}
.blist button {
  display: flex;
  width: 100%;
  align-items: center;
  height: 26px;
  padding: 0 8px;
  border-radius: 5px;
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-family: var(--font);
  text-align: left;
}
.blist button:hover { background: var(--hover); color: var(--text); }
.blist .hint { margin: 0; padding: 6px 8px; color: var(--text-dim); font-size: var(--fs-xs); }
</style>
