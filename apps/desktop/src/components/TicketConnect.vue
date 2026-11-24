<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { TicketsStatus } from '@cockpit/shared'
import { client } from '../core/store.js'

/**
 * §5 — the way into a project's Jira, given once per machine: the Atlassian
 * account's email and an API token. Checked against Jira before it is kept;
 * the token goes to the keychain, never into a file the repository can see.
 */

const props = defineProps<{ projectId: string; status: TicketsStatus }>()
const emit = defineEmits<{ connected: [status: TicketsStatus] }>()

const email = ref(props.status.email ?? props.status.suggestedEmail ?? '')
const token = ref('')
const busy = ref(false)
const problem = ref('')
const tokenField = ref<HTMLInputElement | null>(null)
const emailField = ref<HTMLInputElement | null>(null)

const TOKENS = 'https://id.atlassian.com/manage-profile/security/api-tokens'

onMounted(() => (email.value ? tokenField.value : emailField.value)?.focus())

async function connect() {
  if (busy.value || !email.value.trim() || !token.value.trim()) return
  busy.value = true
  problem.value = ''
  const r = await client.call('tickets.connect', { projectId: props.projectId, email: email.value, token: token.value })
  busy.value = false
  if (r.ok) {
    token.value = ''
    emit('connected', r.status)
  } else {
    problem.value = r.reason
  }
}
</script>

<template>
  <div class="connect">
    <div class="row">
      <input
        ref="emailField"
        v-model="email"
        class="input"
        type="email"
        spellcheck="false"
        autocomplete="off"
        placeholder="Atlassian email"
        @keydown.enter="connect"
      />
      <input
        ref="tokenField"
        v-model="token"
        class="input"
        type="password"
        autocomplete="off"
        placeholder="API token"
        @keydown.enter="connect"
      />
      <button class="btn primary" :disabled="busy || !email.trim() || !token.trim()" @click="connect">
        {{ busy ? 'Checking…' : 'Connect' }}
      </button>
    </div>
    <p v-if="problem" class="help bad">{{ problem }}</p>
    <p v-else class="help">
      <a :href="TOKENS" target="_blank" rel="noreferrer noopener" title="Kept in this Mac's keychain">Create a token</a>
      for {{ status.site.replace(/^https?:\/\//, '') }}
    </p>
  </div>
</template>

<style scoped>
.connect { display: flex; flex-direction: column; gap: 7px; }
.row { display: flex; gap: 6px; }
.row .input { flex: 1; min-width: 0; }
/* The fields' height, so the three read as one line. */
.row .btn { flex: none; height: auto; align-self: stretch; }
.help { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); line-height: 1.55; }
.help a { color: var(--accent); text-decoration: none; }
.help a:hover { text-decoration: underline; }
.help.bad { color: var(--danger); }
</style>
