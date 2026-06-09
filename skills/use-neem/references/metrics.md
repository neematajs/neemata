# Metrics

Use `@nmtjs/metrics/neem` to attach metrics to a Neem project. Metrics is a
Neem controller plugin: it runs in the main Neem process, observes lifecycle and
health state, exposes a Prometheus-compatible endpoint, and collects worker
metrics. It is not a runtime declaration and should not be listed in
`runtimes`.

## Project Config

```ts
import metrics from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  plugins: [
    metrics({
      server: {
        host: '127.0.0.1',
        port: 9187,
        path: '/metrics',
      },
    }),
  ],
  runtimes: ['./src/runtimes/**/neem.runtime.ts'],
})
```

Defaults:

- `server.host`: `0.0.0.0`.
- `server.port`: `9187`.
- `server.path`: `/metrics`.
- `defaultMetrics`: `true`.

## Default Metrics

`metrics()` enables default metrics by default. It adds a package-owned build
plugin that injects `registerDefaultMetrics()` into built runtime entries. Set
`defaultMetrics: false` when a project wants only explicitly declared metrics.

```ts
metrics({
  defaultMetrics: false,
  server: { port: 9187 },
})
```

## Pushgateway

Configure `server.push` to push metrics periodically and once during shutdown:

```ts
metrics({
  server: {
    push: {
      url: 'http://127.0.0.1:9091',
      name: 'api',
      interval: 15_000,
    },
  },
})
```

Rules:

- `name` is required when push is enabled.
- `url` defaults to `http://127.0.0.1:9091`.
- `interval` is milliseconds.
- Shutdown sends a final push before the metrics server stops.

## Boundaries

- Metrics plugin belongs in `plugins`, not `runtimes`.
- Metrics server resource creation happens inside the plugin hooks, not in
  `neem.config.ts`.
- The plugin combines main-controller metrics with worker metrics.
- Custom application metrics use the root metrics helpers from `nmtjs` or
  `@nmtjs/metrics`; the Neem plugin exposes and pushes the collected registry.
