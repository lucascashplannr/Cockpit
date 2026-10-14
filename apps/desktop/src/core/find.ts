import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { EditorView, keymap } from '@codemirror/view'
import type { Panel } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, setSearchQuery,
} from '@codemirror/search'
import FindBar from '../components/FindBar.vue'

/**
 * ⌘F over a file: the Code tool, and the Diff in all three of its readings.
 * The Terminal's find field, laid over the top of the text — the same field,
 * the same keys, the same tint on what matched — so finding reads as one
 * thing wherever it is.
 */

/** Past this the count stops: a number nobody reads, at the cost of a pass over the file. */
const CAP = 999

export interface Hits {
  index: number
  count: number
  more?: boolean
}

/* ── in an editor ──────────────────────────────────────────────────────── */

function findPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-find'
  // Bumped on every change the count could depend on, and when the query is
  // set from outside the field (⌘F over a selection seeds it).
  const bus = reactive({ tick: 0, seeded: 0 })

  const Bar = defineComponent(() => {
    const q = ref(getSearchQuery(view.state).search)

    const hits = computed<Hits | null>(() => {
      void bus.tick
      if (!q.value) return null
      const state = view.state
      const query = getSearchQuery(state)
      if (!query.valid) return { index: -1, count: 0 }
      const sel = state.selection.main
      const cursor = query.getCursor(state)
      let count = 0
      let index = -1
      for (let m = cursor.next(); !m.done; m = cursor.next()) {
        if (count === CAP) return { index, count, more: true }
        if (m.value.from === sel.from && m.value.to === sel.to) index = count
        count++
      }
      return { index, count }
    })

    /** As it is typed: the first match from where the caret is, not after it. */
    function land() {
      const query = new SearchQuery({ search: q.value, literal: true })
      view.dispatch({ effects: setSearchQuery.of(query) })
      if (!q.value || !query.valid) return
      let m = query.getCursor(view.state, view.state.selection.main.from).next()
      if (m.done) m = query.getCursor(view.state).next()
      if (m.done) return
      view.dispatch({
        selection: { anchor: m.value.from, head: m.value.to },
        effects: EditorView.scrollIntoView(m.value.from, { y: 'center' }),
        userEvent: 'select.search',
      })
    }

    watch(q, land)
    watch(
      () => bus.seeded,
      () => {
        const s = getSearchQuery(view.state).search
        if (s !== q.value) q.value = s
      },
    )

    return () =>
      h(FindBar, {
        modelValue: q.value,
        'onUpdate:modelValue': (s: string) => (q.value = s),
        hits: hits.value,
        onStep: (dir: 1 | -1) => (dir === 1 ? findNext : findPrevious)(view),
        onClose: () => closeSearchPanel(view),
      })
  })

  const app = createApp(Bar)
  return {
    dom,
    top: true,
    mount() {
      app.mount(dom)
    },
    update(u) {
      const seeded = u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
      if (seeded) bus.seeded++
      if (seeded || u.docChanged || u.selectionSet) bus.tick++
    },
    destroy() {
      app.unmount()
    },
  }
}

const findChrome = EditorView.theme({
  // Its own layer: the panel is pinned at z-index 300 inside the editor,
  // which would otherwise draw it over the header's menus.
  '&': { isolation: 'isolate' },
  '.cm-panels': { backgroundColor: 'var(--surface-review)', color: 'var(--text)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  // The Terminal's tint for "this matched": the warn hue, soft; the one you
  // are on, less so.
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 20%, transparent)', borderRadius: '2px' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' },
})

/** What an editor needs to be searched: the panel, its tint, and ⌘G. */
export const findInEditor: Extension = [
  search({ top: true, literal: true, createPanel: findPanel }),
  keymap.of([{ key: 'Mod-g', run: findNext, shift: findPrevious, preventDefault: true }]),
  findChrome,
]

/** ⌘F for an editor, through `useFindKey`. */
export function editorFind(v: EditorView | null) {
  if (!v) return null
  return {
    el: v.dom,
    open() {
      openSearchPanel(v)
      // Already open: openSearchPanel leaves a focused field be. Select the
      // query, as ⌘F does in a field that already has one.
      const field = v.dom.querySelector<HTMLInputElement>('[main-field]')
      field?.focus()
      field?.select()
    },
  }
}

/* ── in rows of text ───────────────────────────────────────────────────── */

/**
 * The Diff's Unified and Split readings are rows, not an editor. The matches
 * are drawn with the CSS Custom Highlight API (`::highlight(find)` in
 * base.css), so finding never re-renders a row or disturbs its colour, and a
 * row that changes under the field — the agent still writing — is read again.
 *
 * Only the text of a line is searched (`.txt` in a row that is not `.meta`):
 * not the numbers, not the signs, not the hunk headers.
 */
export function useTextFind(root: Ref<HTMLElement | null>) {
  const open = ref(false)
  const q = ref('')
  const hits = ref<Hits | null>(null)
  const bar = ref<{ focus(): void } | null>(null)
  let ranges: Range[] = []
  let at = 0
  let fresh = false

  function paint() {
    const reg = CSS.highlights
    if (!ranges.length) {
      reg.delete('find')
      reg.delete('find-on')
      return
    }
    reg.set('find', new Highlight(...ranges))
    const on = new Highlight(ranges[at]!)
    on.priority = 1
    reg.set('find-on', on)
  }

  function scan() {
    ranges = []
    const el = root.value
    if (!open.value || !q.value || !el) {
      hits.value = null
      paint()
      return
    }
    const re = new RegExp(q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    let more = false
    outer: for (const txt of el.querySelectorAll<HTMLElement>('.line:not(.meta) .txt')) {
      const nodes: Text[] = []
      const starts: number[] = []
      let text = ''
      const walk = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
        nodes.push(n)
        starts.push(text.length)
        text += n.data
      }
      if (!text) continue
      // The text node an offset falls in; an end is put in the node it ends.
      const place = (off: number, end: boolean): [Text, number] => {
        let k = nodes.length - 1
        while (k > 0 && (end ? starts[k]! >= off : starts[k]! > off)) k--
        return [nodes[k]!, off - starts[k]!]
      }
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (ranges.length === CAP) {
          more = true
          break outer
        }
        const r = new Range()
        r.setStart(...place(m.index, false))
        r.setEnd(...place(m.index + m[0].length, true))
        ranges.push(r)
      }
    }
    if (fresh) at = 0
    at = Math.min(at, Math.max(0, ranges.length - 1))
    hits.value = { index: ranges.length ? at : -1, count: ranges.length, more }
    paint()
    if (fresh) reveal()
    fresh = false
  }

  /** The match you are on, brought to the middle if it is not in sight. */
  function reveal() {
    const el = root.value
    const r = ranges[at]
    if (!el || !r) return
    const box = el.getBoundingClientRect()
    const m = r.getBoundingClientRect()
    if (m.top < box.top || m.bottom > box.bottom) el.scrollTop += m.top - box.top - box.height / 2
    if (m.left < box.left || m.right > box.right) el.scrollLeft += m.left - box.left - box.width / 2
  }

  function step(dir: 1 | -1) {
    if (!ranges.length) return
    at = (at + dir + ranges.length) % ranges.length
    hits.value = { ...hits.value!, index: at }
    paint()
    reveal()
  }

  function close() {
    open.value = false
  }

  /** Another file under the same field: back to its first match. */
  function rewind() {
    fresh = true
    scan()
  }

  /** Read again after the rows change: Vue replaces their text, and a range into a node it dropped finds nothing. */
  let due = false
  const watcher = new MutationObserver(() => {
    if (due) return
    due = true
    queueMicrotask(() => {
      due = false
      scan()
    })
  })
  watch(
    root,
    (el) => {
      watcher.disconnect()
      if (el) watcher.observe(el, { childList: true, subtree: true, characterData: true })
      scan()
    },
    { flush: 'post' },
  )
  watch([q, open], () => {
    fresh = true
    scan()
  })
  onBeforeUnmount(() => {
    watcher.disconnect()
    CSS.highlights.delete('find')
    CSS.highlights.delete('find-on')
  })

  return {
    open,
    q,
    hits,
    bar,
    step,
    close,
    rewind,
    /** ⌘F for these rows, through `useFindKey`; null when they are not shown. */
    target() {
      const el = root.value
      if (!el) return null
      return {
        el,
        open() {
          const sel = window.getSelection()?.toString() ?? ''
          if (sel && !sel.includes('\n') && sel.length <= 100) q.value = sel
          if (open.value) bar.value?.focus()
          else open.value = true // FindBar focuses itself on mount.
        },
      }
    },
  }
}

/* ── the key ───────────────────────────────────────────────────────────── */

/**
 * ⌘F from anywhere in the tool, not only from inside the text: a read-only
 * file takes no focus, and the tree or the file list beside it is where the
 * hand usually is. Left alone when focus is somewhere else in the window —
 * the composer, a dialog — which is not this file's to answer.
 */
export function useFindKey(target: () => { el: HTMLElement; open(): void } | null) {
  function onKey(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
    const t = target()
    // Not shown: the Code tool reading a Markdown preview or a picture.
    if (!t || e.defaultPrevented || !t.el.getClientRects().length) return
    const at = document.activeElement
    // The whole tool is "here" — the Code tree, the Diff's file list.
    const here = t.el.closest('[data-tool]') ?? t.el
    if (at && at !== document.body && !here.contains(at)) return
    e.preventDefault()
    t.open()
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
