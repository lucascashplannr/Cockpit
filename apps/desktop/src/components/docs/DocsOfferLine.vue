<script setup lang="ts">
import { computed, ref } from 'vue'
import { BookOpen } from '@lucide/vue'
import { dismissDocsOffer, draftDocsOffer, goTo, state } from '../../core/store.js'

/**
 * §9 — "these pages may be out of date", as a line in the thread of the
 * conversation that did the work, at the moment it became final. One click
 * drafts them here; "Not now" lets them go. The why of each page is on hover:
 * the line says how many, the Docs tool says which.
 */

const props = defineProps<{ offerId: string }>()

const offer = computed(() => {
  for (const s of Object.values(state.docsSignals)) {
    const o = s.offers.find((x) => x.id === props.offerId)
    if (o) return o
  }
  return null
})

const busy = ref(false)

const what = computed(() => {
  const o = offer.value
  if (!o) return ''
  const bits: string[] = []
  const pages = o.pages.filter((p) => !p.missing).length
  const missing = o.pages.length - pages
  if (pages) bits.push(pages + (pages === 1 ? ' page' : ' pages') + ' may be out of date')
  if (missing) bits.push(missing + (missing === 1 ? ' page' : ' pages') + ' missing')
  if (o.memory.length && !o.pages.length) bits.push(o.memory.length + ' settled in memory')
  return bits.join(', ')
})

const why = computed(() => {
  const o = offer.value
  if (!o) return ''
  return [
    ...o.pages.map((p) => p.path + (p.missing ? ' (new)' : '') + '\n  ' + p.reasons.join('\n  ')),
    ...(o.memory.length ? ['Memory: ' + o.memory.length + ' lasting ' + (o.memory.length === 1 ? 'entry' : 'entries')] : []),
  ].join('\n')
})

async function draft(): Promise<void> {
  if (!offer.value || busy.value) return
  busy.value = true
  try {
    await draftDocsOffer(offer.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <p v-if="offer" class="undone compacted docoffer" :title="why">
    <BookOpen class="sm" />
    <span class="dl">Docs</span>
    <span class="tx">{{ offer.label }} — {{ what }}</span>
    <template v-if="offer.state === 'open'">
      <button class="btn tiny" :disabled="busy || !offer.sessionId" @click="draft">Draft</button>
      <button class="btn ghost tiny" :disabled="busy" @click="dismissDocsOffer(offer)">Not now</button>
    </template>
    <button v-else-if="offer.state === 'drafting'" class="btn ghost tiny" @click="goTo('docs')">In Docs</button>
    <span v-else class="st">{{ offer.state === 'done' ? 'drafted' : 'let go' }}</span>
  </p>
</template>

<style scoped>
.docoffer { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dl { font-weight: 600; }
.tx { min-width: 0; }
.st { color: var(--text-dim); }
</style>
