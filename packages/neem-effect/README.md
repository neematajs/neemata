# @nmtjs/neem-effect

An alternative Neem application host built on Effect 4. It shares Neem's
compiler, application contracts, development artifact handling, plugins, and
native proxy. The host and worker lifecycle implementation lives in this package.

## Run

Build the workspace first, then select the alternative CLI:

```sh
vp env exec pnpm build
vp env exec node packages/neem-effect/bin/neem-effect.js dev --config neem.config.ts
vp env exec node packages/neem-effect/bin/neem-effect.js build --config neem.config.ts --outDir dist-effect
vp env exec node packages/neem-effect/bin/neem-effect.js start --outDir dist-effect
```

The built `dist-effect/start.js` also starts directly with Node. Use a separate
output directory when comparing hosts. A build records its host implementation;
starting it with a different host's CLI fails with an explanatory error.

Existing Neem configurations, planners, workers, and framework presets can use
their existing imports. Applications still own their HTTP servers and transports.
They do not have to use Effect internally. `@nmtjs/effect` is the application
preset; `@nmtjs/neem-effect` is the host implementation.

When installed in an application, use the `neem-effect` binary directly.

## CLI

The command tree uses Effect 4's `effect/cli` (`Command`, `Flag`, and
`Argument`), with `NodeServices` and `NodeRuntime` supplying platform services
and signal handling. Effect currently marks this CLI API unstable. Command
actions are shared with Neem; the alternative has no direct Citty dependency.

```sh
neem-effect --help
neem-effect dev --help
neem-effect --version
neem-effect --completions bash # also zsh, fish, sh
neem-effect dev api,jobs --no-cache --env-files .env,.env.local
neem-effect build --out-dir dist-effect
```

`--outDir` and `--cacheDir` remain aliases for `--out-dir` and `--cache-dir`.
Flags are validated before the command runs. On SIGINT/SIGTERM, the CLI aborts
the action and waits for its cleanup; a graceful stop exits successfully, while
a cleanup failure still exits unsuccessfully. Runtime diagnostics go to stderr.

## Ownership and transport

The host serializes mutations with `Semaphore`; shutdown interrupts the active
operation and closes its resources. Each runtime owns a generation scope, which
owns its planner/host runner and parallel worker scopes. A generation's failure
`Deferred` cannot restart a newer generation. Application replacement is serialized
inside each worker, and a cancelled queued patch cannot release another patch's permit.

Effect `RpcClient` / `RpcServer`, schemas, `Transferable`, and
`NodeWorkerRunner` provide requests, replies, cancellation, and MessagePort
transfer. Host-side `Worker.makePlatform` owns readiness buffering and the
receive loop's response-handler fibers. A single-worker `RpcClient.Protocol`
bridge connects it to RPC; a Node adapter supplies events and deadline-aware
native cleanup. It intentionally has no transparent respawn: Neem's runtime
supervisor owns restart policy, backoff, and exhaustion. Fatal exit reports use
a separate synchronous frame so they survive an immediate process exit.

The receive scope is registered before native acquisition. Finalizers therefore
send the stop request, close the RPC client, wait for native exit (or terminate
at the deadline), and finally close the receive scope. That order lets a stop
buffered before readiness reach the worker. Interrupting the receive loop first
would discard that opportunity and force termination. The native worker belongs
to the outer lifetime even though `makePlatform` manages its receive loop.

Every shutdown step spends one absolute deadline. Worker scopes stop together;
a stuck finalizer cannot prevent sibling cleanup. Workers still alive at the
deadline are terminated and shutdown reports failure. Promise-based application
factories remain supported, including ones that finish after shutdown begins.

The existing compiler, watcher, DevEngine freshness rules, native proxy, and
plugin contracts are shared through an internal host-flavor seam. The original
host remains available. Workflows and distributed cluster scheduling are outside
this package's scope.

## First-party services and custom policy

Effect owns background fibers (`FiberSet` / `FiberHandle`), scopes, serialization,
monotonic deadlines, and retry schedules. Callback fibers capture the caller's
Effect services, including its clock and tracing context. Cancelling a queued
host operation removes it before it can mutate the running server.

Lifecycle hooks execute sequentially as Effects. Hooks may return an Effect, a
Promise, or nothing; an interrupted hook cannot continue invoking later callbacks.
Plugin acquisitions register disposal immediately, including partial startup.
`definePluginHooks` from this package also accepts Effect factories using
`acquireRelease`; their resources belong to a plugin scope closed within the
host's shutdown budget.
Plugins dispose in reverse acquisition order. Existing Hookable registries are
accepted at the embedding boundary; the default registry does not use Hookable.
`createHostHooks` and `PluginHooks` are exported from `@nmtjs/neem-effect/host`.

The proxy controller uses Effect serialization and scheduled retries. The native
proxy still forwards traffic. Neem retains route selection, readiness policy,
restart decisions, generation identity, and the single shared shutdown budget.
A native call or Promise that cannot be cancelled may finish after the caller's
budget; its cleanup remains owned and workers can still be forcibly terminated.

Effect Schema validates manifests, runtime upstreams, and RPC envelopes. Normal
RPC failures use Effect's error codec; opaque application values retain structured
clone support (including Maps, BigInts, and typed arrays). Diagnostics therefore
use Effect's schema errors instead of Zod's. The shared compiler still writes the
same manifest format; the original Neem implementation keeps its own validators
and has no Effect dependency.

Effect Config resolves runtime environment overrides and host settings. Invalid
`NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS` values now fail startup instead of accepting
partial numbers. `NEEM_EFFECT_TRACING=true` enables RPC tracing; host operations
and recovery attempts also expose Effect spans to an installed tracer. No tracing
exporter is installed automatically. **Pino remains the logger.**

Plain dotenv files use Effect FileSystem and ConfigProvider, preserving file order
and existing environment values. Files using variable expansion or dotenvx
encryption retain the dotenvx adapter. The compiler, artifact watcher, and
DevEngine remain shared with Neem; adopting Effect does not replace their build
or module-update engines.

`Deadline.make(ms)` captures the active Effect clock. `Deadline.after(ms)` is the
synchronous live-clock convenience. `Deadline.at` is monotonic time, not a Unix
timestamp; pass relative budgets through the factories.

## Embed in an Effect application

```ts
import * as Effect from 'effect/Effect'
import { loadSnapshot, serve } from '@nmtjs/neem-effect/host'

const program = Effect.scoped(
  Effect.gen(function* () {
    const snapshot = yield* loadSnapshot({
      mode: 'production',
      outDir: './dist-effect',
      manifestFile: './dist-effect/neem.manifest.json',
    })
    const host = yield* serve(snapshot)
    console.log(host.getHealth())
    yield* Effect.never
  }),
)
```

Run `program` with your application's Effect runtime and signal handling.
Closing its scope stops the host; acquisition failure or interruption also
cleans up resources already acquired. The `Host` methods return Effects.
`EffectHostController` is the Promise facade used by the shared development CLI.

## Verification and comparison

```sh
vp env exec pnpm --filter @nmtjs/neem-effect exec vitest run --config vitest.unit.config.ts --reporter=agent
vp env exec pnpm --filter @nmtjs/neem-effect exec vitest run --config vitest.e2e.config.ts --reporter=agent
vp env exec pnpm --filter @nmtjs/neem-effect exec vitest run --config vitest.stress.config.ts --reporter=agent
vp env exec pnpm bench:neem-effect 7 4
```

The end-to-end and stress suites reuse Neem's behavioral scenarios with the
alternative CLI. Unit tests exercise this implementation's ownership and failure
handling. The comparison script alternates hosts after a warm-up and reports raw
samples and median startup, shutdown, and Linux process RSS for the same idle
application. Its arguments are measured runs per host and application workers.
It measures host overhead, not application throughput; adopting Effect alone
does not establish a speed improvement.

### Measurement with the Effect CLI

Linux, Node 24.16.0, four idle application workers, seven alternating samples
per host after one discarded warm-up (2026-10-14):

| Median                                |    Neem | Neem Effect |
| ------------------------------------- | ------: | ----------: |
| CLI startup to runtime readiness      |  254 ms |      422 ms |
| SIGTERM to process exit               |   18 ms |       25 ms |
| Process RSS, including worker threads | 205 MiB |     283 MiB |

This implementation is currently slower to start and uses more memory. Loading
Effect in each isolate accounts for much of the additional startup cost;
replacing custom lifecycle machinery is not itself a performance improvement.
These numbers describe an idle fixture on one machine, not request throughput
or a production capacity estimate. Re-run the comparison for your application.

### Worker platform evaluation

Adopted `Worker.makePlatform` after comparing it against an isolated copy of the
previous direct-Node transport, with the same Effect CLI and application. Fifteen
alternating samples per version after a warm-up, four idle workers, Linux and
Node 24.16.0 (2026-10-14) produced these medians:

| Median      | Previous transport | Worker.makePlatform |
| ----------- | -----------------: | ------------------: |
| Startup     |           418.6 ms |            420.4 ms |
| Shutdown    |            25.4 ms |             25.2 ms |
| Process RSS |          281.7 MiB |           283.0 MiB |

There is no demonstrated speed improvement. The integration adds about 60 lines
to the transport while replacing detached response fibers with first-party
scoped handling and adding first-party readiness buffering. That ownership
boundary is the reason to adopt it. The default `NodeWorker` adapter's fresh
five-second cleanup budget and the RPC worker pool's automatic retry remain
unsuitable for this host's coordinated recovery and absolute shutdown deadline
(verified against installed Effect 4.0.0).

Validation includes ownership/configuration/schema unit tests, 106 end-to-end
tests, and 3 stress tests.
Transport regressions cover a queued stop before readiness, delayed ready with
MessagePort transfer, exit before readiness, fatal report followed immediately
by exit, pending requests during a crash, and a failed native spawn. Existing
tests cover hanging finalizers, recovery, reloads, and packaged applications.
