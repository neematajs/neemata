export default defineNuxtConfig({
  telemetry: false,
  devtools: { enabled: false },
  // Polling keeps the real watcher behavior available under restricted test sandboxes.
  watchers: { chokidar: { usePolling: true, interval: 100 } },
  vite: { server: { watch: { usePolling: true, interval: 100 } } },
  routeRules: { '/about': { prerender: true } },
})
