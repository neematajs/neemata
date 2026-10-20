export default defineNuxtConfig({
  telemetry: false,
  devtools: { enabled: false },
  // Polling keeps the real watcher behavior available under restricted test sandboxes.
  watchers: { chokidar: { usePolling: true, interval: 100 } },
  // Deployment-style map settings at the levels below `sourcemap`: preview
  // must still link maps, a regular build must keep these. The Rolldown
  // output setting takes precedence over `build.sourcemap` in Vite.
  sourcemap: { client: true },
  nitro: { sourceMap: false },
  vite: {
    build: {
      sourcemap: 'hidden',
      rolldownOptions: { output: { sourcemap: 'hidden' } },
    },
    server: { watch: { usePolling: true, interval: 100 } },
  },
})
