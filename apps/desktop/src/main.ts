import { createApp } from 'vue'
import App from './App.vue'
import { applyTheme, client } from './core/store.js'
import './styles/base.css'

applyTheme()
client.connect()
createApp(App).mount('#app')
