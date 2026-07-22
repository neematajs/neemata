# @nmtjs/vite

Prototype Neem runtime preset for hosting Vite-powered apps behind the Neem
proxy, with a single declaration covering both dev and production.

```ts
// neem.runtime.ts
import { createViteRuntime } from '@nmtjs/vite'

export default createViteRuntime({
  name: 'web',
  root: import.meta.dirname,
  proxy: { routing: { type: 'default' } },
})
```

- `neem dev` — the runtime worker boots Vite's own dev server (HMR included)
  and registers it as an upstream; Neem's watcher never rebuilds on app source
  changes, Vite owns that module graph.
- `neem build` — a rolldown plugin on the worker artifact runs `vite build`
  into the artifact's `app/` directory; the prod worker serves it with an
  srvx-based static server (bundled into the artifact) and never imports vite.

The dev/prod split is done at bundle time: the plugin resolves the
`neem-vite:impl` virtual module to `neem/dev.ts` under `rolldown.watch` and to
`neem/prod.ts` under `rolldown.build`, so neither artifact carries the other
mode's code or any mode flags.

See `playground/` for a runnable example (`pnpm run playground:dev`,
`pnpm run playground:build`, `pnpm run playground:start`).
