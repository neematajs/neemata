# Neemata × Effect migration

Date: 2026-09-21
Status: migration direction approved; implementation follows in slices 2–6.
The decoded-Type decision below supersedes the earlier Encoded submission/mapper decision.
Baseline: `b2602ae0be76e92dfc06f0392977263c2883ff9c` (`main`).

This plan supersedes [Application Interfaces](application-interfaces-plan.md).
The next major version is a clean break: existing applications migrate explicitly.
There will be no parallel Neemata/Effect handler APIs or framework compatibility
facade. The purpose is to reduce the maintenance and test surface.

**Effect executes handlers; Neemata coordinates durable work.** Neem hosts
applications and supervises their workers. Workflows retains its declared graph,
durable state, scheduling, leases, retries, and store adapters.

## Package boundaries

| Package                                                                                                               | Destination                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@nmtjs/neem`                                                                                                         | Keep the host, compiler, reload, lifecycle, proxy integration, and worker supervision. Own Pino logging; no Effect dependency. |
| `@nmtjs/vite`, `@nmtjs/nuxt`                                                                                          | Keep the existing Neem presets.                                                                                                |
| `@nmtjs/workflows`                                                                                                    | Keep the engine and adapters; replace public schemas, handlers, service composition, and client boundaries with Effect APIs.   |
| `@nmtjs/effect`                                                                                                       | Small Neem adapter for a Layer and a supervised main effect; applications own HTTP/RPC.                                        |
| `@nmtjs/metrics`                                                                                                      | Retain Neem host/worker observation. Assess whether its forked Prometheus client is still needed.                              |
| `@nmtjs/common`                                                                                                       | Keep utilities used by surviving packages; prune after consumers are removed.                                                  |
| `@nmtjs/unplugin-labels`                                                                                              | Remove in slice 2, including compiler transforms.                                                                              |
| `application`, `gateway`, `core`, `contract`, `type`, `protocol`, `transports`, `client`, `config`, `pubsub`, `nmtjs` | Delete in slice 6 after application and workflow migration.                                                                    |

Applications own RPC, HTTP, MCP, upload protocols, and their Effect integrations.
Structured metadata plus multipart/HTTP uploads or file references replace nested
remote blob streams where needed. Rebuilding Neemata's wire protocol is out of
scope. Redis pubsub is not a retained package without a concrete requirement.

## Slice 1 — Record the boundary

- Record the package disposition and clean major-version break here.
- Mark the former application-interface plan as historical.
- Keep current-version documentation until its replacement is ready; clearly link
  the next-major direction.

## Slice 2 — Detach Neem

- Move default host logger construction into Neem, using Pino directly. Keep the
  configuration shape, custom logger modules, labels, thread IDs, and pretty output.
  Core's request-local logging context stays with the legacy framework.
- Replace core logger type imports in Neem and metrics with Pino types.
- Remove `unplugin-labels`, both compiler hooks, workspace references, and lockfile
  dependencies. Automatic injectable declaration labels cease to be a host feature.
- Preserve the host's existing queues, lifecycle, and public runtime contract.
- Make the packaged-consumer test install Neem and its retained dependencies only.
  Old-framework interoperability fixtures can keep development dependencies until
  slice 6; they are not runtime dependencies of the published host.

Completion: Neem, Vite, and Nuxt build and run without a runtime dependency on the
old framework. Packaged declarations resolve without it. Reload, worker-failure,
shutdown, and preset tests pass. Run watcher e2e tests with unrestricted filesystem
access before attributing watcher failures to Neem.

## Slice 3 — Effect preset and an application proof

- Pin exact Effect versions from the first dependency addition. Verify APIs against
  that version; previous research snippets were not compiled contracts.
- Retained libraries import only stable `effect/*` modules. Application code owns
  `effect/unstable/*` integrations. Enforce this with scoped oxlint
  `no-restricted-imports` rules for workflows and the preset, plus a rule banning
  all `effect` and `effect/*` imports in Neem.
- Accept a Layer and a long-lived main effect. Define an explicit readiness/upstream
  handoff so the application supplies upstreams without the preset importing HTTP.
- One scoped fiber owns the Layer and the main effect; its Exit drives
  `NeemRuntime.finished` after finalization. Main resources finalize before layer
  services. A separate ManagedRuntime is unnecessary for this single entry point.
  An exit before stop was requested is a runtime failure, including successful
  early completion. Long-lived background work must be composed into the main
  effect or explicitly supervised; detached failures are not automatically fatal.
- Define and test startup failure, main-effect failure, stop, disposal, and reload.
- Port a real service under Neem with its application-owned Effect RPC/HTTP stack.

**Go/no-go gate before slice 4:** choose and demonstrate the non-Effect frontend
boundary in a real application: an application-owned Promise wrapper over RpcClient,
or HttpApi → OpenAPI/client generation. Validate error handling, cancellation,
streaming where used, uploads, and any former connection-scoped state. Do not create
a new generic Neemata client abstraction to hide the decision. Stop at slices 1–3
if the application boundary does not justify the remaining migration.

## Slice 4 — Workflow codecs and stored representation

- Replace `@nmtjs/type` contracts with Effect Schema codecs. Persist the encoded,
  JSON-compatible representation; decode at execution/read boundaries. Cover inputs,
  task/activity outputs, and continuation data rather than only final results.
- Existing persistence validates/decodes and then JSON-stringifies decoded values.
  Test transformed values and round trips explicitly; plain JSON schemas alone do
  not establish correctness.
- Preserve current retry/restart eligibility and history API behavior. Stored-format
  markers, legacy-run restrictions, and worker format-negotiation mechanisms are
  separate engine capabilities, deferred until after the Effect migration.
- Characterize representation differences against existing persisted fixtures and
  record their release implications. Data compatibility and any deployment cutover
  procedure are assessed in slice 6; they do not require a versioning feature here.

Completion: Effect codecs cover all persistence boundaries, transformed values round
trip correctly, and retry/restart eligibility and history APIs retain their semantics.
Typed failure codecs are deferred: retain `toStoredError` for the first release.

## Slice 5 — Effect workflow execution boundary

Keep the coordinator, scheduling, durable graph, store adapters, and lease machinery
in their current async style. Convert handlers and service composition to Effect;
do not translate the engine wholesale. The audit found 11 workflow files importing
core or type, including coordinator, worker, and Neem integration code, so this is
larger than just `implement/`.

Decoded-Type decision (supersedes the earlier Encoded submission/mapper decision):
every typed programmatic workflow API accepts and returns the schema's decoded
**Type**. This includes `start` and its returned input/output, task/activity handlers,
workflow finish, input mappers, map items and per-item input callbacks, code-defined
schedule inputs, and tags/idempotency/unique callbacks. The engine encodes once with
`Schema.toCodecJson` when writing store rows, queued commands, or child payloads,
and decodes when reading them. Encoding validates input and retains user-facing
"Invalid … input" failures. Restart decodes stored input and calls `start(Type)`.
Untyped `get`, `list`, `listSummaries`, history and inspector reads retain stored JSON
because definitions are unavailable. Raw JSON callers decode explicitly; there is
no `startEncoded` API. Remove authored-Encoded aliases/helpers and the separate
activity mapper input parameter. Transforming-schema tests must cover direct
Date/number submissions, handlers, mappers, map items and finish, JSON storage and
restart. This is one clean major-version API, not a compatibility facade.

Run each handler with `runPromiseExit(effect, { signal })` using the service Context
captured from the worker's Layer. These entry-point fibers are not children of the
preset's main fiber: sharing its Context does not share its lifetime. The engine must
track attempts and register a main-scope finalizer that stops new claims, aborts
every active attempt, and drains their fibers/finalizers before Layer services are
released. Cover this order in a test that observes service disposal during shutdown.
The engine's AbortController remains the authority for the reason: cancellation,
timeout, shutdown, or lease loss.

| Handler outcome                           | Engine action                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Success                                   | Validate/encode and commit only with valid lease/attempt fencing.             |
| Typed failure or defect (`Fail` or `Die`) | Apply existing retry policy and attempt accounting.                           |
| Interruption with an engine abort reason  | Use the existing semantics for that reason.                                   |
| Interruption without an engine reason     | Unexpected attempt failure; consume an attempt and apply normal retry policy. |

Inspect Cause contents rather than assuming every failure has one reason; test mixed
failure/interruption cases. `Effect.promise` rejections are defects, so retrying only
typed failures would silently change existing retry behavior.

Interruption does not cancel underlying Promise work that ignores it, and a lease
can expire between handler success and persistence. **Commit fencing remains
mandatory for every result**, including after timeout or lease loss.

Bound cleanup waiting. An overrun stops new claims and makes the worker fail health
or runtime supervision so Neem recycles the thread. Prove the existing host recovery
path can do this before relying on it. `worker.terminate()` also kills sibling
attempts; their expired leases must be taken over safely. An uninterruptible region
or non-cooperative Promise cannot be forcibly stopped by an Effect deadline alone.
An overrun is not a successful drain: fence commits and escalate to thread recycling
instead of treating shared services as safe to dispose while attempts still use them.

The roughly 26k lines of workflow tests are a substantial part of this slice. A
test-only async-to-Effect helper may keep existing engine tests tractable. Add native
Effect cases for defects, typed errors, interruption, scoped cleanup, overrun, lease
loss, and late commits. No public async-handler compatibility API.

## Slice 6 — Remove the retired framework and release

- Delete retired packages and their tests, exports, scripts, CI jobs, fixtures, and
  unused dependencies. Prune common utilities after their consumers disappear.
- Narrow metrics to Neem observation. Applications can export their metrics directly
  from each worker through OTLP. Retain cross-worker aggregation only where the host
  needs it; check whether `@nmtjs/prom-client` can also be removed.
- Document application migration, client choice, uploads, loss of connection scope,
  and workflow codec/data compatibility. **Draining is required at cutover:** pause
  new submissions and schedule firing, drain queued/delayed/active runs and their
  children under the old release, then stop all old workers before enabling new
  writers. A re-entry decode mismatch fails an in-flight run terminally, so a mixed
  deployment is not an acceptable default. Check retained stored data against the
  new codecs before resubmitting historical runs; a drain does not convert history.
  This is a deployment procedure, not a change to retry/restart eligibility. No
  general format-versioning feature or legacy-run ban is required by this migration.
  For Redis alternatives, state
  at-most-once delivery and reconnect gaps rather than promising equivalent pubsub.
- Before removing the old framework, prove one real CaseNetwork stream and one
  upload flow (chat is a candidate). Unary organization search does not establish
  either, and neither blocks workflow codec development in slice 4.
- While old and new runtimes coexist in migration experiments, select the new host
  through an explicit package alias and keep the old framework's peer graph intact.
  Do not promise an in-place Neem bump in an otherwise legacy application. The
  release target remains an explicit complete application migration, followed by
  removal of the alias and all retired packages; no legacy compatibility release
  is planned as part of this work.
- Configure application logging and RPC error metrics. HTTP 200 responses carrying
  application failures are not visible as failures to the proxy's HTTP status metrics.
  The slice-3 preset has no automatic Pino bridge; applications own their Effect
  logger configuration. Preserve complete Cause diagnostics before production.
- Publish the new package map and supported exact Effect version. Recheck upstream
  release status and unstable APIs at this point rather than relying on old research.

Completion: retained package builds and release artifacts contain no retired framework
imports; the migrated application and full retained test suite pass.

## Separate follow-ups

- After the Effect migration is complete, consider stored-format/codec versioning,
  worker compatibility enforcement, and policies for retrying/restarting older runs.
  These engine behavior changes are outside slices 4–6. The earlier proposal to make
  legacy history raw-only and prohibit its retry/restart is deferred, not adopted.
- A graph hash can detect node insertion/reordering for in-flight runs. It does not
  version handler behavior or codecs and is not a substitute for format compatibility.
- Add Temporal codecs or new graph nodes only for a demonstrated application need.
- No Effect RPC, HTTP, Redis, or workflow reimplementation belongs in the host.

## Slice 1–2 validation — 2026-09-20

Validated in the `dev/effect-migration` worktree with unrestricted filesystem access.
All commands used `vp env exec`.

| Check                                               | Result                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm tsc -b tsconfig.build.json --pretty false`    | Full workspace build passed.                                                                                                                                                 |
| `pnpm tsc -b tsconfig.json --noEmit --pretty false` | Full workspace typecheck passed.                                                                                                                                             |
| Neem unit/integration suite                         | 108 tests passed, including logger destination routing and error causes.                                                                                                     |
| Neem e2e suite                                      | 72 tests passed, including isolated package consumer, reload, failure recovery, and shutdown.                                                                                |
| Nuxt unit and e2e suites                            | 17 + 11 tests passed; actual development and production apps exercised.                                                                                                      |
| Metrics suite                                       | 19 tests passed.                                                                                                                                                             |
| Vite playground smoke                               | Build, production, and development passed; both `/` and `/admin/` pages and script assets served, graceful shutdown verified. Temporary fixture removed.                     |
| Published dependency audit                          | Neem, Vite, Nuxt, and metrics have no transitive workspace runtime/peer dependencies on retired packages. Generated JS and declarations have no core/type/labels references. |
| `pnpm run fmt`, `git diff --check`                  | Passed.                                                                                                                                                                      |
| `pnpm oxlint . --format=agent`                      | No errors; one existing warning in unchanged `transports/src/http-server/deno.ts:32`.                                                                                        |

Vitest used `--reporter=agent` with each package's unit/e2e config (metrics uses
`vitest.config.ts`). No Effect dependency or workflow implementation changed in
these slices. The old framework remains available for existing applications until
its later removal.

## Slice 3 validation — 2026-09-20

Added [`@nmtjs/effect`](../packages/effect/README.md), with exact `effect` and
application/test platform pins at `4.0.0-rc.116`. This is a release candidate, not
a stable v4 release ([upstream release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.116)).
The retained-library import rules reject unstable/platform imports, and Neem rejects
Effect entirely. Temporary prohibited-import probes were rejected and then removed.

The worker API is `defineEffectWorker(() => ({ layer, main: ready => effect }))`.
One scoped fiber replaces the initially proposed ManagedRuntime plus main fiber.
The unit suite verifies readiness, partial startup cleanup, typed failures, defects,
interruption, unexpected success, finalizer order, and idempotent lifecycle methods.
An HTTP application fixture verifies real Neem build/start, failure recovery, and
development reload with the previous listener closed.

| Check                            | Result                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Neemata build and typecheck | Passed.                                                                                                                                                                   |
| Preset unit/type suite           | 14 tests passed; missing layer services rejected by the compiler.                                                                                                         |
| Preset Neem e2e suite            | 3 tests passed with unrestricted filesystem access.                                                                                                                       |
| Full Neemata oxlint              | No errors; the existing Deno transport warning remains.                                                                                                                   |
| CaseNetwork backend              | 77 tests passed, including 7 new real HTTP RPC tests; backend typecheck and changed-file lint passed.                                                                     |
| CaseNetwork Dashboard            | Production build passed. Existing limited typecheck passed with 38 dependency diagnostics ignored.                                                                        |
| CaseNetwork real application     | Seeded auth + PostgreSQL + Neem proxy + Promise client smoke passed. Chromium signed in, loaded organization search, and selected an organization on assignment creation. |

The real proof is in the isolated CaseNetwork worktree
`/Users/den/.codex/worktrees/effect-proof/casenetwork`, branch `dev/effect-proof`,
based on `origin/main` at `01837dc4`. Its reproduction instructions and local staging
scripts are in `.dev/effect-proof/`. Those files are intentionally ignored under
CaseNetwork's temporary-work conventions; this is local proof packaging, not a
release-ready dependency setup. No original checkout or deployment was modified.

**Client choice demonstrated:** an application-owned Promise wrapper over RpcClient.
Four Vue selectors now call `directory.search(input, { signal })`; the legacy search
procedure was removed. The client uses browser-safe runtime schemas, a ManagedRuntime
for the HTTP protocol, and a scope per call. Errors retain their declared tags/codes.
Abort and client disposal tests verify server-side finalizers run.

Two boundaries needed explicit handling:

- In the pinned version, HTTP handling starts uninterruptible. The application marks
  the RPC HTTP effect interruptible so disconnecting closes its scope. This belongs
  in the application, not the stable-only preset. Its PostgreSQL query remains
  non-cooperative: interrupted RPC work cannot promise that SQL has stopped.
- Authentication is revalidated per request by the existing auth application, with
  an administrator check before the query. This adds a session HTTP round trip; it
  does not introduce a connection-scoped identity cache. The selected flow did not
  depend on persistent connection-local state.

The local new-host package initially changed legacy peer resolution and duplicated
`ApiError` classes. A clean baseline comparison confirmed the regression. Keeping
legacy dependencies consistent and selecting the staged host with a local package
alias fixed it; the complete backend suite then passed without changing its tests.

**Gate assessment:** the real unary application/client criterion is demonstrated.
Streams, uploads, Temporal codecs, and connection-dependent services were not exercised
by this flow. Explicit upload handling is an accepted paradigm change, not a request
to rebuild the retired protocol. The remaining application migration is substantial,
but no generic Neemata client facade was needed. Make the go/no-go decision on this
boundary before starting slice 4; neither workflow storage nor execution was changed.

## Slice 3 review follow-up — 2026-09-20

The independent review reproduced the preset and backend checks and the real browser
flow. Its results are review evidence, not additional local test runs. Two defects
were independently reproduced and corrected:

- `no-restricted-imports` now uses `effect/**`, `effect/unstable/**`, and `@effect/**`.
  The initial shallow probes were insufficient: `*` does not cover nested paths.
  Deep HTTP/RPC/platform imports must be rejected in each retained package's scope.
- `EffectApplication<R, EL, EM>` infers Layer and main errors independently. A positive
  type case with distinct tagged errors previously failed with TS2322. Negative
  cases still reject missing main services and unprovided Layer inputs.

The e2e scratch directories are now ignored. Formatting follows the repository's
formatter; the lint change should contain only the new boundary overrides.

Fresh follow-up validation: the workspace build and typecheck passed; the preset
has 15 unit/type tests and 3 e2e tests passing. All 44 prohibited-import probes across
seven lint scopes were rejected, and their temporary files were removed. Full oxlint
still reports only the unchanged Deno warning. The CaseNetwork staged package was
refreshed from the rebuilt declarations, and its backend typecheck passed. Formatting
and `git diff --check` passed; no application implementation changed.

**Startup-stop decision: document and defer the host fix.** A temporary real-host
probe acquired a Layer resource, suspended main before readiness, and sent SIGTERM.
It reproduced forced termination after about five seconds with exit code 1 instead
of graceful finalization. The probe was removed after reproduction; it is not counted
as a passing lifecycle test. There are multiple host boundaries to fix together:

1. `HostController.stop()` is queued behind startup, and `startRuntimes()` only
   publishes runtimes after their starts complete.
2. The worker entry gates normal `runtime.stop()` on `started`.
3. `ThreadController.start()` can terminate the worker when its pending readiness
   promise rejects during stop, racing cleanup.

Changing only the worker's `started` condition would not fix the full SIGTERM path.
The preset README now distinguishes its direct stop contract from Neem's host
behavior. Fix and test shutdown during runtime creation, pending start, and reload
as a separate host lifecycle change before production rollout. This known limitation
does not block slice 4's codec work.

**CaseNetwork follow-ups before its next RPC migration:** normalize Promise-client
rejections using Exit (preserve DirectoryError, return the AbortSignal reason for
caller abort, and expose a consistent application transport error for other failures,
including disposal); enforce allowed Origin/content type before dispatching mutations;
log internal database failures while retaining a safe public error. Strengthen the
client tests beyond `toBeDefined()`, and enforce browser-safe client/contract imports.
These are recorded requirements, not fixes applied to the proof in this patch.
Move auth in-process for the full application migration instead of keeping the
proof's per-call session HTTP hop.

**Gate:** the two preset blockers are fixed and the host limitation is explicit.
Conditional go for slice 4; production readiness still requires the follow-ups above.
