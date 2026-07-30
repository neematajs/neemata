export default defineNuxtConfig({
  telemetry: false,
  devtools: { enabled: false },
  // Exercises the prod static layer's index.html resolution: prerendered
  // pages land in public/about/index.html and are removed from the server
  // routes.
  routeRules: {
    '/about': { prerender: true },
  },
})
