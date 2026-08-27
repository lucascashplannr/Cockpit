import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  // Pinned to IPv4, not left as the default `localhost`.
  //
  // `localhost` resolves to ::1 first on macOS, so Vite bound [::1]:5273 only
  // — while the dev script probes 127.0.0.1 and electron/main.cjs loads
  // http://127.0.0.1:5273. Three places already assumed IPv4 and nothing said
  // so, which surfaced as "vite never came up" seconds after Vite printed
  // "ready". Naming the host makes all three agree.
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome128' },
})
