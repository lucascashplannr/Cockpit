<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ExternalLink, RotateCw } from '@lucide/vue'
import type { TicketDetail, TicketRef } from '@cockpit/shared'
import { client } from '../core/store.js'
import MarkdownPreview from './MarkdownPreview.vue'

/**
 * §5 — the ticket a topic was made from, as the badge on the bar opens it.
 *
 * Read from Jira each time it opens, never kept: what the topic stores is only
 * what the badge needs (the key, the title, the status), and this is where
 * those catch up with Jira. Read only: a change to the ticket is made in Jira,
 * one click away.
 */

const props = defineProps<{ projectId: string; topicId: string; ticket: TicketRef }>()

const detail = ref<TicketDetail | null>(null)
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  const r = await client
    .call('tickets.get', { projectId: props.projectId, key: props.ticket.key, topicId: props.topicId })
    .catch((e: Error) => ({ ticket: null, error: e.message }))
  loading.value = false
  error.value = r.error ?? ''
  if (r.ticket) detail.value = r.ticket
}
onMounted(load)

function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
</script>

<template>
  <div class="tk">
    <div class="th">
      <code class="mono key">{{ ticket.key }}</code>
      <span class="status" :class="detail?.phase">{{ detail?.status ?? ticket.status }}</span>
      <span v-if="detail?.type" class="type">{{ detail.type }}</span>
      <span class="grow" />
      <button class="icon-btn" :class="{ spin: loading }" title="Read it again" @click="load"><RotateCw class="sm" /></button>
      <a class="icon-btn" :href="detail?.url ?? ticket.url" target="_blank" rel="noreferrer noopener" title="Open in Jira">
        <ExternalLink class="sm" />
      </a>
    </div>

    <div class="doc">
      <h1>{{ detail?.title ?? ticket.title }}</h1>

      <p v-if="error" class="bad">{{ error }}</p>

      <template v-if="detail">
        <dl class="facts">
          <template v-if="detail.priority"><dt>Priority</dt><dd>{{ detail.priority }}</dd></template>
          <dt>Assignee</dt><dd>{{ detail.assignee ?? 'Unassigned' }}</dd>
          <template v-if="detail.parent">
            <dt>Parent</dt>
            <dd>
              <a :href="detail.parent.url" target="_blank" rel="noreferrer noopener">
                <code class="mono">{{ detail.parent.key }}</code> {{ detail.parent.title }}
              </a>
            </dd>
          </template>
          <template v-if="detail.labels.length"><dt>Labels</dt><dd>{{ detail.labels.join(', ') }}</dd></template>
        </dl>

        <MarkdownPreview v-if="detail.description" class="desc" :source="detail.description" />
        <p v-else class="none">No description.</p>

        <section v-if="detail.subtasks.length">
          <h2>Sub-tickets</h2>
          <a
            v-for="s in detail.subtasks"
            :key="s.key"
            class="sub"
            :href="s.url"
            target="_blank"
            rel="noreferrer noopener"
          >
            <code class="mono">{{ s.key }}</code>
            <span class="nm">{{ s.title }}</span>
            <span class="status" :class="s.phase">{{ s.status }}</span>
          </a>
        </section>

        <section v-if="detail.comments.length">
          <h2>Latest comments</h2>
          <div v-for="(c, i) in detail.comments" :key="i" class="comment">
            <div class="who"><strong>{{ c.author }}</strong><span>{{ day(c.at) }}</span></div>
            <MarkdownPreview :source="c.body" />
          </div>
        </section>
      </template>
      <p v-else-if="loading && !error" class="none">Asking Jira…</p>
    </div>
  </div>
</template>

<style scoped>
.tk { display: flex; flex-direction: column; min-height: 0; max-height: inherit; }
.grow { flex: 1; }

.th {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--line-overlay);
}
.key { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.type { font-size: var(--fs-xs); color: var(--text-dim); }
.status { font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; }
.status.doing { color: var(--accent); }
.status.done { color: var(--ok); }
.spin :deep(.lucide) { animation: turn 0.9s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }

.doc { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px 20px; }
h1 { margin: 0 0 12px; font-size: var(--fs-md); font-weight: 640; letter-spacing: -0.01em; line-height: 1.4; color: var(--text); }
h2 { margin: 20px 0 6px; font-size: var(--fs-sm); font-weight: 620; color: var(--text); }

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px 14px;
  margin: 0 0 14px;
  font-size: var(--fs-xs);
}
.facts dt { color: var(--text-dim); }
.facts dd { margin: 0; color: var(--text-muted); min-width: 0; }
.facts code { font-size: inherit; }
a { color: inherit; text-decoration: none; }
.facts a:hover { color: var(--accent); }

/* The preview is a page of its own elsewhere, with a page's margins; here it
   is a part of this card, on the title's edge, at the card's size. */
.doc :deep(.mdp) { max-width: none; margin: 0; padding: 0; font-size: var(--fs-sm); }

.sub {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 8px;
  margin: 0 -8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
}
.sub:hover { background: var(--hover); }
.sub code { flex: none; font-size: var(--fs-xs); color: var(--text-muted); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }

.comment + .comment { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line-overlay); }
.who { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; font-size: var(--fs-xs); color: var(--text-dim); }
.who strong { color: var(--text-muted); font-weight: 600; }

.none { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.bad { margin: 0 0 12px; font-size: var(--fs-sm); color: var(--danger); }
</style>
