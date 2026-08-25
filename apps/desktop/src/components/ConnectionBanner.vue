<script setup lang="ts">
import { LoaderCircle, RefreshCw, Unplug } from '@lucide/vue'
import { client, state } from '../core/store.js'

/**
 * §13 — one of the four consequences of a permanent service that must be
 * handled from the first milestone: "état « noyau injoignable » visible dans
 * l'interface avec relance". Silence here would be the worst failure mode,
 * because everything on screen would simply be stale and look fine.
 */
</script>

<template>
  <div v-if="state.connection !== 'connected'" class="banner" :class="state.connection">
    <LoaderCircle v-if="state.connection === 'connecting'" class="sm spin" />
    <Unplug v-else class="sm" />
    <span class="txt">
      <template v-if="state.connection === 'connecting'">Connecting to the core…</template>
      <template v-else-if="state.connection === 'incompatible'">
        Version mismatch — {{ state.connectionDetail }}
      </template>
      <template v-else>
        Core unreachable. Servers and agents keep running; this window is showing stale state.
      </template>
    </span>
    <button
      v-if="state.connection !== 'connecting'"
      class="btn ghost small"
      @click="client.reconnectNow()"
    >
      <RefreshCw />Retry
    </button>
  </div>
</template>

<style scoped>
.banner {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--overlay);
  box-shadow: var(--shadow-md), var(--inset-top);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  -webkit-app-region: no-drag;
}
.banner.disconnected, .banner.incompatible { color: var(--danger); }
.txt { white-space: nowrap; }
.btn.small { height: 24px; padding: 0 10px; font-size: var(--fs-xs); }
.btn.small .lucide { width: 12px; height: 12px; }
</style>
