<script setup lang="ts">
import { h } from 'vue'
import type { Seg } from '../core/editor.js'

/** One line of a diff, in the editor's colours when it has them, as plain text when not. */
const props = defineProps<{ segs?: Seg[] | null; text: string }>()

// A render function: a template would put whitespace between the spans.
const Line = () =>
  props.segs ? props.segs.map((s) => (s.cls ? h('span', { class: s.cls }, s.text) : s.text)) : props.text
</script>

<template><Line /></template>
