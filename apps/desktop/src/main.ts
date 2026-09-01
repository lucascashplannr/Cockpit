import { createApp } from 'vue'
import App from './App.vue'
import { applyTheme, client } from './core/store.js'

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
createApp(App).mount('#app')
