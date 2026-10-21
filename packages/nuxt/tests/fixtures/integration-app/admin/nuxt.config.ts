export default defineNuxtConfig({
  telemetry: false,
  devtools: { enabled: false },
  // Polling keeps the real watcher behavior available under restricted test sandboxes.
  watchers: { chokidar: { usePolling: true, interval: 100 } },
  // Deployment-style map settings at each level Nuxt reads: build and
  // preview both keep them. The Rolldown output setting takes precedence
  // over `build.sourcemap` in Vite.
  sourcemap: { client: true },
  nitro: { sourceMap: false, rollupConfig: { output: { sourcemap: false } } },
  vite: {
    build: {
      sourcemap: 'hidden',
      rolldownOptions: { output: { sourcemap: 'hidden' } },
    },
    server: { watch: { usePolling: true, interval: 100 } },
  },
})
