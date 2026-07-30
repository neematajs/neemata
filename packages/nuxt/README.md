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

For path-routed proxies pass `base` (applied as `app.baseURL`) matching the
route, e.g. `base: '/admin/'`.

## Prototype status

Tested against Nuxt 4 / nitropack v2. Not covered yet: nitro v3 shapes
(fetch-only dev server, `node-middleware` preset), app-level WebSocket
routes in production (crossws), `nuxt generate` static output, and hard
dev restarts are handled by failing the worker (host restart policy
recycles it).
