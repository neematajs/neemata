# @nmtjs/nuxt

Neem runtime preset for hosting Nuxt apps behind the Neem proxy with a single
runtime declaration covering both dev and production.

```ts
// neem.runtime.ts
import { createNuxtRuntime } from '@nmtjs/nuxt'

export default createNuxtRuntime({
  name: 'web',
  root: import.meta.dirname,
  proxy: { routing: { type: 'default' } },
})
```

- `neem dev` — the runtime worker boots Nuxt's dev pipeline (`loadNuxt` +
  `buildNuxt`, the same entry points nuxt/cli uses) behind a worker-owned
  listener; SSR, module transforms, and the Vite HMR WebSocket all ride the
  Neem proxy on a single origin. Nuxt owns the app's module graph and
  watchers — Neem's watcher never rebuilds on app source changes.
- `neem build` — a rolldown plugin on the worker artifact runs the Nuxt
  build with the nitro `node` preset into the artifact's `app/` directory;
  the prod worker imports the nitro server entry (SSR preserved) and serves
  the client assets in front of it. The artifact stays self-contained and
  relocatable.
- `neem preview` — the same production build and server, with output under
  `.neem/preview/`, and linked browser and server source maps unless the app
  sets its own. Neem applies its setting per side (browser, server) through
  Nuxt's `sourcemap`, only where no config source Nuxt merges (the app, its
  layers, `.nuxtrc`) sets that side, so the app's `sourcemap` wins. Turning a side on still lets the app's
  `nitro.sourceMap`, Nitro Rollup output, or `vite.build` settings (including
  `$client`/`$server` and Rolldown output options) refine it; Neem never turns
  off a side the app sets maps for at any of those levels. `neem dev` applies
  the same default; regular builds keep Nuxt's production default of no
  browser maps unless Neem's `build.sourcemap` is set.

`dev` and `build` share Nuxt's intermediate directory (`buildDir`, default
`.nuxt`), as with the Nuxt CLI; avoid building an app while its dev server runs.
`preview` writes its intermediates next to the preview artifact
(`.neem/preview/<config name>/runtime/<runtime>/.nuxt`) and leaves `.nuxt` alone.

For path-routed proxies pass `base` (applied as `app.baseURL`) matching the
route, e.g. `base: '/admin/'`.

## Prototype status

Tested against Nuxt 4 / nitropack v2. Not covered yet: nitro v3 shapes
(fetch-only dev server, `node-middleware` preset), app-level WebSocket
routes in production (crossws), `nuxt generate` static output, and hard
dev restarts are handled by failing the worker (host restart policy
recycles it).
