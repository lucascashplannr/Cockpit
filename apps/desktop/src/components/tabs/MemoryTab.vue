<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentSessionFile, MemoryDoc, Workspace } from '@cockpit/shared'
import { BookMarked, Pencil, Plus } from '@lucide/vue'
import { client, guard, toast } from '../../core/store.js'

/**
 * §6 — the layer nobody else builds. Three distinct things live here:
 * the durable memory, the disposable sessions, and (in the Journal tab) the
 * automatic log. The whole point: "vider devient gratuit".
 */

const props = defineProps<{ workspace: Workspace }>()

const doc = ref<MemoryDoc | null>(null)
const sessions = ref<AgentSessionFile[]>([])
const draft = ref('')
const editing = ref(false)
const promoteText = ref('')
const promoteSection = ref('Décisions')

const SECTIONS = ['Objectif', 'Décisions', 'Contraintes', 'Écarté', 'État']

const sections = computed(() => doc.value?.sections ?? [])

async function load() {
  editing.value = false
  const [d, s] = await Promise.all([
    guard(() => client.call('memory.read', { workspaceId: props.workspace.id })),
    guard(() => client.call('memory.sessions', { workspaceId: props.workspace.id })),
  ])
  doc.value = d ?? null
  sessions.value = s ?? []
  draft.value = d?.content ?? ''
}

async function save() {
  const r = await guard(
    () => client.call('memory.write', { workspaceId: props.workspace.id, content: draft.value }),
    'memory saved',
  )
  if (r) {
    editing.value = false
    await load()
  }
}

/** §6 — "Promotion." Without a one-gesture path from a thought to the memory,
 *  the memory never gets written. */
async function promote() {
  const text = promoteText.value.trim()
  if (!text) return
  const r = await guard(() =>
    client.call('memory.promote', {
      workspaceId: props.workspace.id,
      section: promoteSection.value,
      text,
    }),
  )
  if (r) {
    promoteText.value = ''
    toast('ok', 'promoted into ' + promoteSection.value)
    await load()
  }
}

/** The template's italic guidance is scaffolding, not content — it may span
 *  several lines, so it is stripped as a block rather than line by line. */
function bodyPreview(body: string): string {
  return body.replace(/^_[\s\S]*?_$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

watch(() => props.workspace.id, load, { immediate: true })
</script>

<template>
  <div class="mem">
    <div class="main">
      <div v-if="!doc && !editing" class="empty">
        <BookMarked />
        <strong>No memory yet</strong>
        <span>
          The memory outlives every agent session — it is what makes clearing one free (§6).
        </span>
        <button class="btn primary" @click="editing = true; draft = ''">Start a memory</button>
      </div>

      <template v-else-if="!editing">
        <div class="doc">
          <section v-for="s in sections" :key="s.title" class="sec" :class="{ discarded: s.title === 'Écarté' }">
            <h3>
              {{ s.title }}
              <!-- §6 — "la section la plus précieuse". Say so in the interface. -->
              <span v-if="s.title === 'Écarté'" class="hint">the one that stops a fresh session
                re-proposing what you already rejected</span>
            </h3>
            <pre v-if="bodyPreview(s.body)" class="body selectable">{{ bodyPreview(s.body) }}</pre>
            <p v-else class="none">—</p>
          </section>
        </div>
      </template>

      <template v-else>
        <textarea v-model="draft" class="editor mono selectable" spellcheck="false" />
      </template>

      <footer class="foot">
        <template v-if="editing">
          <button class="btn primary" @click="save">Save</button>
          <button class="btn ghost" @click="editing = false; load()">Cancel</button>
        </template>
        <template v-else-if="doc">
          <button class="btn ghost" @click="editing = true"><Pencil />Edit raw</button>
          <span class="grow" />
          <span class="path mono">{{ doc.path }}</span>
        </template>
      </footer>
    </div>

    <aside class="side">
      <div class="block">
        <span class="section-label">promote into memory</span>
        <div class="promote">
          <select v-model="promoteSection" class="select sel">
            <option v-for="s in SECTIONS" :key="s" :value="s">{{ s }}</option>
          </select>
          <textarea
            v-model="promoteText"
            class="input ptext selectable"
            rows="4"
            placeholder="A decision, a constraint, or something you ruled out — and why."
            @keydown.meta.enter="promote"
          />
          <button class="btn primary" :disabled="!promoteText.trim()" @click="promote">
            <Plus />Promote <span class="kbd">⌘⏎</span>
          </button>
        </div>
      </div>

      <div class="block">
        <span class="section-label">sessions ({{ sessions.length }})</span>
        <p class="note">
          Disposable by design. The understanding lives in the memory, so clearing these costs
          nothing.
        </p>
        <div v-for="s in sessions" :key="s.id" class="srow">
          <span class="sname mono">{{ s.id }}</span>
          <span class="sbytes num">{{ Math.round(s.bytes / 1024) }}k</span>
        </div>
        <p v-if="!sessions.length" class="none">No stored session.</p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.mem { display: grid; grid-template-columns: minmax(0, 1fr) 310px; height: 100%; }

.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.doc { flex: 1; overflow-y: auto; padding: 24px 28px 44px; max-width: 800px; }

.sec + .sec { margin-top: 22px; }
.sec h3 {
  margin: 0 0 8px;
  font-size: var(--fs-md);
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--text);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sec .hint {
  font-weight: 400;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.sec.discarded h3 { color: var(--accent); }
.body {
  margin: 0;
  padding: 12px 15px;
  border-left: 2px solid var(--line);
  background: var(--panel);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-family: var(--font);
  font-size: var(--fs-md);
  color: var(--text-muted);
  white-space: pre-wrap;
  line-height: 1.55;
}
.sec.discarded .body { border-left-color: var(--accent); }
.none { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }

.editor {
  flex: 1;
  min-height: 0;
  margin: 12px 16px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.6;
  resize: none;
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 18px;
  border-top: 1px solid var(--line);
}
.grow { flex: 1; }
.path { font-size: var(--fs-xs); color: var(--text-dim); }

.side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow-y: auto;
  padding: 18px 16px 26px;
}
.block + .block { margin-top: 22px; }
.block .section-label { display: block; margin-bottom: 8px; }

.promote { display: flex; flex-direction: column; gap: 7px; }
.sel { width: 100%; }
.ptext { resize: vertical; }

.note { margin: 0 0 8px; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.5; }
.srow {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.sname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbytes { color: var(--text-dim); }
</style>
