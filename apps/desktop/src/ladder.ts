import { createApp } from 'vue'
import Ladder from './Ladder.vue'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/base.css'
document.documentElement.setAttribute('data-theme', new URLSearchParams(location.search).get('theme') ?? 'light')
createApp(Ladder).mount('#app')
