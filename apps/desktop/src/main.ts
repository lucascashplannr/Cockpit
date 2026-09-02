import { createApp } from 'vue'
import App from './App.vue'
import { applyTheme, client, toast } from './core/store.js'

/* The two faces the app is drawn in, bundled rather than requested: an
   offline desktop tool cannot depend on a font CDN, and `-apple-system` alone
   made the window look like whatever machine it was opened on.

   Geist and Geist Mono are one family with one set of shapes — squared bowls,
   flat terminals, a low-contrast even colour — which is the same argument the
   mark makes in pixels. Sans and mono sit next to each other on every row of
   the workspace list, so drawing them from two unrelated families is a seam
   the eye finds every time. */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'

import './styles/base.css'

applyTheme()
client.connect()

const app = createApp(App)

/**
 * One panel's bug should cost one panel.
 *
 * Vue's default for an error thrown inside a render is to log it and leave the
 * scheduler wedged: the subtree that failed goes blank, and — worse — updates
 * after it stop being flushed, so the window is still drawn but no longer
 * answers. It reads as "the app froze" rather than "something is broken", and
 * it hid a one-line undefined for far too long. What it took was a field the
 * daemon did not have yet, which is a thing that will happen again: the core
 * outlives the window that started it.
 *
 * So errors are caught, said out loud, and the app keeps running.
 */
app.config.errorHandler = (err, _instance, info) => {
  const text = err instanceof Error ? err.message : String(err)
  console.error('[cockpit] ' + info, err)
  toast('error', 'Something broke while drawing the window: ' + text)
}

app.mount('#app')
