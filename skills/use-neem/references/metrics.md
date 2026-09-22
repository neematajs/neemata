# Metrics

Use the default export from `@nmtjs/metrics/neem` in config `plugins`.
It observes the Neem controller and collects worker metrics; it is not a runtime
and must not appear in `runtimes`. With CLI dev/start the controller runs in the
runtime service worker; generated standalone entries run it in the main thread.

## Config and Defaults

```ts
import metrics from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  plugins: [
    metrics({
      server: { host: '127.0.0.1', port: 9187, path: '/metrics' },
    }),
  ],
  runtimes: ['./src/runtimes/**/neem.runtime.ts'],
})
```

`NeemMetricsPluginOptions` has only `server?` and `defaultMetrics?`.
Server defaults are host `0.0.0.0`, port `9187`, path `/metrics`.
The plugin starts its HTTP server in `initialize` and closes it in `dispose`;
resource creation does not belong in config evaluation.

`defaultMetrics` defaults to `true`. A build plugin injects
`registerDefaultMetrics()` into runtime worker entries. Set it to `false` to
skip that injection; controller lifecycle/pool metrics and explicitly registered
application metrics remain. Application metrics use the root `@nmtjs/metrics`
helpers. The endpoint combines the controller registry with worker registries.

Lifecycle observations include `neem_lifecycle_events_total`,
`neem_runtime_ready`, and `neem_runtime_pool_threads`. These record lifecycle
hooks and pool health; the runtime-ready gauge is not a replacement for the
server's [readiness probe](runtimes.md#proxy-and-health), which also checks proxy
readiness.

## Pushgateway

```ts
import metrics from '@nmtjs/metrics/neem'

export const plugin = metrics({
  server: {
    push: {
      url: 'http://127.0.0.1:9091',
      name: 'api',
      interval: 15_000,
    },
  },
})
```

- `server.push` requires both `name` (job name) and `interval` (milliseconds).
  There is no default interval. URL defaults to `http://127.0.0.1:9091`.
- Push is periodic (`pushAdd`) and also attempted during shutdown before the
  HTTP server closes. Push errors are logged; final delivery is not guaranteed.
- Push does not disable the HTTP metrics endpoint.

## Deploy-time Overrides

The plugin resolves these live process variables when its factory runs, after
build-time options have been stored in the manifest:

| Variable                     | Overrides                              |
| ---------------------------- | -------------------------------------- |
| `NEEM_METRICS_HOST`          | `server.host`                          |
| `NEEM_METRICS_PORT`          | `server.port`                          |
| `NEEM_METRICS_PATH`          | `server.path`                          |
| `NEEM_METRICS_PUSH_URL`      | `server.push.url`; also enables push   |
| `NEEM_METRICS_PUSH_NAME`     | `server.push.name`                     |
| `NEEM_METRICS_PUSH_INTERVAL` | `server.push.interval` in milliseconds |

Empty values are ignored. Port must be an integer from 0 to 65535; an env push
interval must be a positive integer. Enabling push from env requires name and
interval from env or built config. Name/interval alone do not enable push and
are ignored with a warning if no push config/URL exists. `defaultMetrics` is a
build-time injection setting and has no env override.
