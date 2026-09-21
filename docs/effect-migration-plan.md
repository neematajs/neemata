# Neemata × Effect migration

Date: 2026-09-21
Status: slices 1–5 implemented and reviewed. The workflows core was then made
Effect-free with an `/effect` adapter, definitions moved to Standard Schemas, and
execution pools replaced name-list routing; see the dated sections at the end, which
supersede the slice 4–5 text where they differ. The retired framework packages are
deleted (slice 6); what remains is documentation and release, then application
migration outside this repository.
Baseline: `b2602ae0be76e92dfc06f0392977263c2883ff9c` (`main`).

This plan supersedes the Application Interfaces plan, removed with the framework.
The next major version is a clean break: existing applications migrate explicitly.
There will be no parallel Neemata/Effect handler APIs or framework compatibility
facade. The purpose is to reduce the maintenance and test surface.

**Clean cut (owner decision, 2026-09-21).** Nothing outside our control uses the
framework, so the new stack does not try to be compatible with the previous one in
APIs, packages, or stored workflow data. There is no coexistence alias, no mixed
deployment, no retained-data conversion, and no cutover rehearsal as a release gate.
An application moves wholesale; in-flight workflow runs are finished under the old
release or discarded, and the workflow tables start empty.

**Effect executes handlers; Neemata coordinates durable work.** Neem hosts
applications and supervises their workers. Workflows retains its declared graph,
durable state, scheduling, leases, retries, and store adapters.

## Package boundaries

| Package                                                                                                     | Destination                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nmtjs/neem`                                                                                               | Keep the host, compiler, reload, lifecycle, proxy integration, and worker supervision. Own Pino logging; no Effect dependency.                          |
| `@nmtjs/vite`, `@nmtjs/nuxt`                                                                                | Keep the existing Neem presets.                                                                                                                         |
| `@nmtjs/workflows`                                                                                          | Keep the engine and adapters with an Effect-free core: Standard Schemas, Promise handlers, one `env`. Effect support is the optional `/effect` adapter. |
| `@nmtjs/effect`                                                                                             | Small Neem adapter for a Layer and a supervised main effect; applications own HTTP/RPC.                                                                 |
| `@nmtjs/metrics`                                                                                            | Retain Neem host/worker observation. Assess whether its forked Prometheus client is still needed.                                                       |
| `@nmtjs/common`                                                                                             | Keep utilities used by surviving packages; prune after consumers are removed.                                                                           |
| `@nmtjs/unplugin-labels`                                                                                    | Remove in slice 2, including compiler transforms.                                                                                                       |
| `application`, `gateway`, `core`, `contract`, `type`, `protocol`, `transports`, `client`, `config`, `nmtjs` | Delete in slice 6 after application and workflow migration.                                                                                             |

Applications own RPC, HTTP, MCP, upload protocols, and their Effect integrations.
Structured metadata plus multipart/HTTP uploads or file references replace nested
remote blob streams where needed. Rebuilding Neemata's wire protocol is out of
scope. Pubsub was first listed for deletion; it is retained as an Effect-free core
with an `/effect` adapter, see "Pubsub retained" at the end.

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

## Slice 6 — Remove the framework

The earlier version of this slice gated deletion on CaseNetwork proofs, a coexistence
alias for the new host, and a rehearsed cutover of retained workflow data. The clean
cut above removes those gates: deletion proceeds in this repository on its own, and
applications migrate against the result.

### Deletion and release

- Done: retired packages deleted with their tests, scripts, CI jobs, fixtures, skills
  references and unused dependencies (`application`, `gateway`, `core`, `contract`,
  `type`, `protocol`, `transports`, `client`, `config`, `nmtjs`), and
  `@nmtjs/common` pruned to what the retained packages import. `pubsub` was deleted
  with them and then restored without its framework dependencies.
- Narrow metrics to Neem observation. Applications can export metrics directly from
  workers through OTLP; assess whether the forked `@nmtjs/prom-client` can also go.
- Document the new stack: Neem host and presets, the Effect preset, workflows (core,
  `/effect`, pools, Neem workers) and pubsub, stating its at-most-once delivery
  and reconnect gaps.
- Publish the new package map and supported exact Effect version. Recheck upstream
  release status and unstable APIs at release time.

Completion: retained builds and release artifacts contain no retired imports, and
the retained test suite passes.

### Application migration (outside this repository)

Applications own RPC, HTTP, uploads and their clients. Effect ships typed clients
derived from the same definitions (`HttpApiClient`, `RpcClient`, and OpenAPI output
for any other client), so no Neemata client or transport is rebuilt. The CaseNetwork
proof recorded what an application still has to get right: one rejection contract
for a Promise facade over an Effect client (abort, disposal, transport, defect),
an Origin or content-type check before mutations, logging the underlying cause
before returning a sanitized error, interruptible HTTP handlers, in-process
authentication, and RPC failure metrics despite HTTP 200 application errors.
Workflows can use either flavour; both name a `pool` on tasks and workflows and
need a planner that declares the pools.

## Separate follow-ups

Work that is independent of this migration is tracked in [todo.md](todo.md).

- Cluster-wide limits for workflows: named limits on tasks and runs in flight per
  workflow. Pool concurrency is per-process capacity only.

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

## Slice 4 implementation — 2026-09-20

Work is in `/Users/den/.codex/worktrees/effect-migration/core` on
`dev/effect-migration`. The workflows package now consumes stable `effect/Schema`
with the exact `4.0.0-rc.116` peer/development pin. Its direct `@nmtjs/type`
dependency is removed, and declarations, tests, and benchmarks use native Effect
schemas. The core DI and async handler execution boundary remain for slice 5.

Durable payloads use `Schema.toCodecJson`. Root and scheduled inputs, task/activity
inputs and outputs, map items, child-run payloads, and memoized node outputs now
cross explicit encode/decode boundaries. The submission/mapper convention from
this slice is superseded by slice 5's decoded-Type decision: all typed APIs use
Type and JSON encoding is engine-internal. History reads stored payloads without
definitions; restart decodes stored input before submission. Uniqueness joins
decode the actual stored run.

Two correctness fixes were necessary for that boundary:

- Activity descriptors for branches and parallel members preserved transforming
  schema boundaries. Slice 5 removes the temporary mapper/handler type distinction
  because both now use decoded Type.
- PostgreSQL projections distinguish SQL NULL from JSON null. Presence is carried
  only in query results and consumed by row mapping; it is not a new persisted
  field or format marker. This preserves null-valued node inputs across re-entry
  and allows `Schema.Null` and `Schema.Undefined` to round trip.

The existing plain-JSON regression fixtures retain their payload expectations.
Transformed representations are documented in
[`packages/workflows/README.md`](../packages/workflows/README.md#schema-codecs):
Date values persist as ISO strings, `NumberFromString` as a JSON string rather
than the former decoded number, and explicit Undefined as JSON null. Untyped rich
values cannot be reconstructed and are rejected at persistence boundaries instead
of silently becoming different values. Custom codecs must run synchronously,
require no services, and support Effect's JSON derivation.

No stored-format version, legacy-run restriction, retry/restart eligibility change,
graph guard, database schema migration, or new worker compatibility mechanism was
added. Existing-data compatibility remains a release assessment in slice 6. The
CaseNetwork proof and original checkout were not changed by this slice.

Fresh validation (all commands through `vp env exec`):

| Check                                                                                  | Result                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm tsc -b tsconfig.build.json --pretty false`                                       | Full workspace build passed.                                                                                                                                                                                                 |
| `pnpm tsc -b tsconfig.json --noEmit --pretty false`                                    | Full workspace typecheck passed, including the branch/parallel codec boundary and rejection of service-requiring schemas.                                                                                                    |
| `pnpm vitest run --config vitest.config.ts --reporter=agent` from `packages/workflows` | 30 files passed; 540 tests passed, 2 existing skips.                                                                                                                                                                         |
| New codec regression suite (included above)                                            | 16 tests across memory and PostgreSQL via PGlite: every node kind, separate coordination/execution passes, automatic/manual retry, restart, joins, schedules, JSON null/Undefined, and rejection of untyped non-JSON output. |
| `pnpm oxlint . --format=agent`                                                         | No errors; only the existing Deno transport warning.                                                                                                                                                                         |
| `pnpm run fmt`, formatting check, `git diff --check`                                   | Passed.                                                                                                                                                                                                                      |

The null-valued PostgreSQL regression failed before the projection fix and passed
afterwards. An existing race-injection test matched only bare `SELECT *`; its hook
now recognizes the run-read boundary with additional projected columns, and the
concurrent-completion protection test passes. Live-service PostgreSQL integration
specs were typechecked but not run in this slice; database-backed execution used
PGlite. No deployment, commit, or push was performed.

**Status:** slice 4 complete. Slice 5 is next; stored-format versioning and the other
deferred engine capabilities remain outside the migration scope.

## Slice 4 review follow-up — 2026-09-20

The output-less child regression was reproduced independently: both parallel and
mapWorkflow parents completed with memory storage but failed after PostgreSQL
serialized their aggregates and dropped undefined output keys. Untyped aggregate
output fields now use `Schema.optionalKey(Schema.Unknown)`; declared outputs remain
required. Separate PGlite tests exercise each node through a later continuation,
and a JSON-round-trip negative test protects required declared outputs. The memory
store remains an in-memory adapter, not a serialization simulator.

The smaller findings are also addressed:

- Parallel/map output codecs are cached per immutable node declaration. Leaf/case
  codecs retain their existing schema cache. Values are still decoded per pass;
  this removes repeated schema construction, not the cost of traversing a large map.
- `restart()` now returns the existing decoded `RunnableRun` model, with the
  incorrect `StoredRun` casts removed. Its runtime behavior and eligibility are
  unchanged. A type assertion covers the public return contract.
- Removed the stray dispatch-object blank lines.

The slice-5 decoded-Type convention supersedes the earlier Encoded-mapper decision:
all typed submissions, handlers, finish results, mappers, map items and schedules
carry Type; persistence encodes once and untyped history retains stored JSON.
The README records that custom
JSON derivation failures are detected with actual values at runtime, and that an
explicit undefined optional struct field stores as null while an absent key stays
absent. A registration-time probe cannot validate arbitrary codecs without suitable
input values; applications should test representative values.

Slice 6 now requires a drain and exclusion of old writers at cutover. Re-entry decode
errors are terminal, and draining does not migrate retained history. Historical
codec compatibility must be assessed separately before resubmission. Format
versioning and retry/restart restrictions remain deferred.

Fresh validation: the full workspace build and typecheck passed. All 30 workflow
test files passed: **545 tests passed, 2 existing skips**, including 21 codec tests.
The two new PostgreSQL regressions failed before the fix and passed afterwards.
Full oxlint reports only the existing Deno transport warning. Formatting and
`git diff --check` passed. Live-service integration suites were not rerun; the
PostgreSQL regression coverage used PGlite. Work remains uncommitted in
`dev/effect-migration`; slice 5 implementation has not started.

## Slice 5 implementation — 2026-09-21

Workflow task/activity handlers and finish now return native Effects. Core handler,
Container, dependency-dictionary, plugin and execution-environment plumbing is
removed from workflows, including its `@nmtjs/core` dependency. Implementations,
branch/parallel activities and adapter factories retain their service requirements;
`defineWorkflows` and `defineWorkflowsWorker` require a closed Layer that supplies
them. Handler Scope is provided by the engine, independently of the main scope.

All typed submissions, mappers, map items, schedules, handlers and finish use decoded
Type. The shared codec writes JSON once at persistence boundaries and reconstructs
Type on reads. Obsolete authored-Encoded aliases/helpers and the separate activity
mapper type parameter are removed. `start` and restart return decoded views; history
and other definition-free reads still return stored JSON.

One scoped main fiber owns the worker Layer and adapter. The handler executor uses
stable `Effect.runPromiseExitWith(context)` with the engine AbortSignal and a Scope
per invocation. It retains actual fiber completion promises after a cleanup deadline
expires. The main finalizer stops claims, aborts attempts/finish, joins the worker
loop, drains those promises, and only then disposes the adapter and Layer. This
preserves lifetime ordering even when an execution had been awaiting a store read
when shutdown began.

Typed failures, defects and unexplained interruptions consume attempts under the
existing retry policy. Engine cancellation/timeout/shutdown/lease-loss reasons keep
their classifications, including mixed interruption/finalizer failures. Single
failures retain existing StoredError behavior; mixed Causes retain their rendered
details. Attempt and coordinator write fencing remains authoritative after success.
Finish remains coordination work with terminal failure semantics; it should assemble
results, while retryable or long-running work belongs in tasks/activities.

`cleanupTimeoutMs` defaults to 5 seconds per pool. An overrun stops claims and fails
`NeemRuntime.finished`, allowing existing host supervision to recycle the thread.
The deadline remains active through adapter and Layer finalization; a stuck
Layer cannot leave a failed worker appearing live. An overrun never authorizes
early service disposal. A live PostgreSQL + Neem test
proves recovery of the stuck task and a sibling on a new thread, with no premature
Layer release. Expired-lease takeover redelivers the same durable attempt rather
than manufacturing a handler failure or consuming a business retry.

Existing engine scenarios use a test-only async-to-Effect helper. Native Effect
coverage exercises service requirements, scoped resources, typed/defect/Promise
failures, unexplained and mixed interruption, cancellation, timeout, lease loss,
late output fencing, shutdown resumption and cleanup overruns. No public async
handler compatibility API was added.

The lockfile change for this slice removes workflows' core dependency and adds
Pino for its test logger. Format markers, typed error codecs, graph guards and
retired-framework deletion remain outside this slice.

Fresh validation (all JavaScript/TypeScript commands through `vp env exec`):

| Check                                                                                    | Result                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm tsc -b tsconfig.build.json --pretty false`                                         | Full workspace build passed.                                                                                                                             |
| `pnpm tsc -b tsconfig.json --noEmit --pretty false`                                      | Full workspace typecheck passed, including native Effect requirement/rejection assertions.                                                               |
| Workflows `pnpm vitest run --config vitest.config.ts --reporter=agent`                   | 33 files passed; **564 passed, 2 existing skips**.                                                                                                       |
| Workflows `pnpm vitest run --config vitest.config.ts tests/integration --reporter=agent` | All 4 files and **18 tests passed**, using a dedicated local PostgreSQL 18.6 database with service tests required. Includes actual Neem thread recovery. |
| Effect preset unit/type suite                                                            | **15 tests passed**.                                                                                                                                     |
| `pnpm oxlint . --format=agent`                                                           | No errors; only the existing Deno transport warning.                                                                                                     |
| Formatting and `git diff --check`                                                        | Passed.                                                                                                                                                  |

The integration suite emitted the pg 8 deprecation warning about concurrent queries
on one client; it did not fail. The temporary PostgreSQL container and copied recovery
fixtures were removed after validation. No commits, deployment, CaseNetwork edits,
or retired-framework deletion were made. Changes remain in `dev/effect-migration`.

The slice 5 review and follow-up are recorded below. Slice 6 still requires the
real CaseNetwork stream/upload proof and the documented deployment/data compatibility
assessment before deletion.

## Slice 5 review follow-up — 2026-09-21

The review approved slice 6 preparation. Both lifecycle defects are fixed:
pre-aborted attempts reject with the engine reason before invoking any user code;
worker startup shares one promise across asynchronous definition resolution.
Stopping before a fiber exists settles `finished`, rejects pending startup, and
prevents later resource acquisition. Four regression cases reproduced the defects
before the fixes and pass afterwards.

The major-version callback API now drops the vestigial `ctx` parameter throughout:
handlers take `(input, lifecycle)`, finish and ordinary node callbacks take
`(outputs, workflowInput)`, and map input/idempotency callbacks take
`(outputs, item, workflowInput, index)`. Effect handlers obtain services by yielding
them; synchronous callbacks use explicit arguments or immutable closures. Runtime
calls, implementation types, examples, fixtures, and tests use the same signatures.
The low-level executor still accepts an Effect Context for running handlers.

`lifecycle.signal` is deliberately retained: it exposes the engine's typed abort
reason, while Effect's Promise signal represents fiber interruption. Workflows also
keeps its scoped-fiber supervisor separate from `@nmtjs/effect`: it has a worker
definition and must reject `finished` on fatal overruns before finalizers complete.
Sharing that lifecycle would require extending the preset's public contract; this
follow-up instead adds coverage for the two divergent lifecycle paths.

The README now documents Neem's hard 5-second requested-stop deadline, the existing
startup-stop constraint, and that one cleanup overrun recycles healthy siblings.
Operators should keep finalizers short, budget total cleanup within the host deadline,
and place risky handlers in separate execution pools. No host timeout or startup
behavior is changed here.

CaseNetwork client rejection normalization, request-origin/content-type checks,
and database-cause logging remain prerequisites of its next RPC migration. The real
stream/upload proof and drain/data-compatibility assessment still precede slice 6
deletion. Stored-format markers and legacy-run restrictions remain deferred.

Fresh follow-up validation, all JavaScript/TypeScript commands via `vp env exec`:

- Workspace build and typecheck passed (`tsc -b tsconfig.build.json --pretty false`
  and `tsc -b tsconfig.json --noEmit --pretty false`).
- Workflows: **568 passed, 2 existing skips**, across 33 files.
- Live PostgreSQL 18.6: **18 passed**, across all 4 integration files, including
  actual Neem thread recovery. Service tests were required.
- Effect preset: **15 passed**.
- Full `oxlint . --format=agent`: only the existing Deno transport warning.
- Formatting and `git diff --check` passed.

The temporary PostgreSQL container and copied recovery fixtures were removed and
removal verified. Work remains uncommitted in `dev/effect-migration`; CaseNetwork
and the original checkout were not changed.

## Reviewed slice commits — 2026-09-21

The five reviewed slices were reconstructed in an isolated worktree. Each commit's
state passed the required formatting and checks; the restored slice-4 boundary also
passed all 545 workflow tests with 2 skips. The final commit tree was compared against
the complete reviewed worktree and matched exactly before advancing the branch.

| Slice | Commit     | Scope                                                              |
| ----- | ---------- | ------------------------------------------------------------------ |
| 1     | `2198a37c` | Migration boundary and historical application plan                 |
| 2     | `b9f9f3b8` | Neem-owned logging and labels-plugin removal                       |
| 3     | `d2fd6546` | Stable-only Effect preset and its tests                            |
| 4     | `d44039a8` | Effect Schema codecs and JSON persistence                          |
| 5     | `5b5dbdbd` | Effect execution, Layer services, and reviewed API/lifecycle fixes |

No packages from slice 6 have been deleted. The real workflow proof and dump-backed
cutover assessment remain pending, alongside the tightened stream/upload proof.

## Startup shutdown follow-up — 2026-09-21

Neem now delivers stop while runtime startup is pending. The host and development
supervisor interrupt starting workers before waiting for their operation queues;
worker cleanup is invoked once even when the asynchronous factory is still resolving.
The thread controller leaves termination to the stop deadline instead of killing
finalizers as soon as readiness rejects. Stopped startup cannot emit late readiness.
The hard 5-second worker stop deadline is unchanged.

Regression tests reproduced the previous failures, then passed in production and
development: stop during factory creation, stop during pending startup, and an
asynchronous finalizer that outlives rejection of the start promise.

Fresh validation with unrestricted filesystem access and `vp env exec`:

- Neem unit/integration: **109 passed** across 19 files.
- Neem e2e: **75 passed** across 13 files, including watcher reload and recovery.
- Effect preset host e2e: **3 passed**.
- Workspace build, typecheck, formatting, and `git diff --check` passed.
- Full `oxlint . --format=agent`: only the existing Deno transport warning.

The selected dump has now been assessed in isolated PostgreSQL instances. Its full
workflow subset was restored with constraints and indexes; unrelated application
records were excluded. The assessment covered payloads, commands, history reads,
real restart submissions, an old-release drain, and rollback. Snapshot-specific
aggregate evidence stays in a local report, outside the public repository history.

The cutover procedure written from this exercise was removed with the clean-cut
decision: workflow tables start empty, so none of it applies. For the record, the
exercise identified an existing SQL version-2-to-3 prerequisite, historical definition
and registry drift, and the need to dispose of stranded commands explicitly. A
drain does not make completed-node history valid under changed definitions.

The reviewed application schemas contain no declared Date/Temporal or other rich
transformation codecs. The earlier date-bearing real-workflow proof criterion has
therefore not been demonstrated; do not invent a production field to satisfy it.
The application proof remains pending. Assessment-only Effect schema candidates
test JSON shapes/defaults and reuse existing refinement predicates; repeat the
checks against the final application-owned Effect definitions before release.

No stored-format versioning, legacy-run restrictions, application code changes,
or framework deletion were introduced by this assessment. Full-application rollback
and the actual deployment's submission-pause control are not established by the
isolated workflow-table exercise.

## Code review cleanup — 2026-09-21

A line-by-line review of the slice 3–6 sources found no correctness defects. Its
maintainability findings are applied on top of the startup-shutdown change:

- One handler runtime per worker. Entry points resolve it once; continuation and
  attempt inputs now require `handlers` and no longer carry `context`,
  `cleanupTimeoutMs`, or `onFatal`. The per-attempt fallback created runtimes whose
  pending fibers nobody drained.
- `runWorkflowWorker`/`runExecutionWorker` and their `serve*` forms type `context`
  by the requirements of the implementations they receive, or accept a shared
  `handlers` runtime instead. `createHandlerRuntime` and the handler error classes
  are exported for that purpose. A type test rejects an insufficient context.
- A failure discarded because the worker is shutting down is reported through
  `onError` unless it is the abort reason itself.
- Compiled encoders/decoders are cached per schema; re-entry decodes every
  completed node.
- The preset and the workflows worker render a fiber failure the same way: a lone
  failure keeps its identity, several keep their rendered Cause.
- `Deps` generics are renamed to `R`; the unused `Deps` parameter on start inputs
  is removed.
- Neem's host controller routes each awaited startup/reload step through one
  interruptible `step`, replacing a stop check after every await. The worker entry
  starts initialization before its users and documents its two stop flags.

An independent review of that cleanup reproduced two defects in it, now fixed:

- The `step` helper checked for a stop only after its step. Returning from the
  async helper yields, so a stop landing between two steps saw no runtimes and the
  next step then started them; shutdown waited for readiness. `step` now also
  checks before invoking its step, and the synchronous state transitions are steps
  as well. A unit test sweeps the stop across twelve microtask offsets through the
  real hooks and operation queue; offset 6 failed before the fix.
- A shared `handlers` runtime erased its requirements, so one built from an empty
  context was accepted where a `context` was rejected. `HandlerRuntime<R>` now
  carries the services it provides through a contravariant `run`, the public
  worker inputs require it, and a negative type test covers the path. The erased
  form used below the entry points is the type every runtime is assignable to.

Validation (`vp env exec`, unrestricted filesystem): workspace build and typecheck
passed; workflows **569 passed, 2 skipped**; preset **15** unit/type and **3** e2e
passed; Neem **121** unit and **75** e2e passed; formatting clean; oxlint reports
only the existing Deno warning. Live PostgreSQL 18 integration (**18 passed**) ran
before these two fixes and was not rerun: neither touches the adapter or engine
behaviour it covers.

## Effect-free workflows core — 2026-09-21

Owner decision: the workflow engine is retained infrastructure and must not depend
on Effect. Slices 4 and 5 had put `effect/Schema` and Effect-returning handlers into
its public API, which tied the engine and its stored format to the exact Effect RC
pin and excluded non-Effect runtimes. Effect support is now an adapter on top.

- **Schemas.** Definitions take Standard Schemas, so they keep a real schema
  object: types, validation and, through Standard JSON Schema, the JSON Schema of
  the stored form (`toStoredJsonSchema`) for code generation and tooling. A first
  cut used opaque `decode`/`encode` functions and lost exactly that. Standard
  Schema validates in one direction, so a single schema serves values stored as
  they are, and a transformed value declares a `{ decode, encode }` pair; the
  definition API rejects a single schema whose output is not assignable to its
  input. Validation must be synchronous, and the engine asserts that whatever is
  stored is JSON. The engine walks the parallel and map envelopes itself; "Type
  everywhere" and the absent-versus-null rules are unchanged, and values are still
  encoded per member, so the stored format is unchanged.
- **Dependencies.** No container. Handlers are `(input, lifecycle, env)` and
  `finish` is `(outputs, workflowInput, lifecycle, env)`, returning values or
  Promises. The worker input requires one `env` satisfying every registered
  handler at once (`Env<T>`, an intersection); the engine neither creates nor
  disposes it. The generic half of the old handler runtime stays in the core as
  `createHandlerRunner`: the pre-abort check, the cleanup deadline with `onFatal`,
  and `drain()`.
- **`@nmtjs/workflows/effect`.** `effect` is now an optional peer. The subpath
  exports `defineTask`/`defineWorkflow` over Effect schemas (`createContract` with
  the `codec` conversion: the schema's JSON codec and the same codec flipped, via
  Effect's Standard Schema converters, derived on first use), `implementTask`/`implementWorkflow` over Effect handlers,
  `createHandlerRuntime`, `WorkflowHandlerError`, and worker functions taking a
  `context`. Effect handlers are stored as core handlers whose env is a
  `HandlerRuntime<R>`, so the core's env check is the service-coverage check.
  `schemaOf` returns the schema a definition was declared with, so composing
  schemas from definitions and structure-reading tooling keep working.
- **Two implementation chains.** The definition builders are shared through a
  type-level schema function, which only appears in output positions. The same was
  tried for handlers and abandoned: TypeScript does not infer a handler's services
  through a type-level function for context-sensitive handlers such as
  `(input) => Effect.gen(...)`. The Effect chain therefore mirrors the core chain's
  types and the two must change together; both share one runtime builder.
- **Neem integration.** `defineWorkflows` is now topology only (implementations,
  schedules, pools): the planner reads it on the main thread and never needed the
  services it used to carry. Services belong to the worker definition.
  `@nmtjs/workflows/neem` is Effect-free and its `defineWorkflowsWorker(config,
{ setup })` returns the adapter, the handlers' env and a `dispose`; the env is
  checked against every registered handler. It owns the shutdown ordering (stop
  claims, abort, join loops, drain handlers, dispose) and the cleanup deadline, so
  non-Effect applications do not reimplement them. The Effect worker moved to
  `@nmtjs/workflows/effect/neem` as `defineWorkflowsWorker(config, { layer,
runtime })`, unchanged in behaviour, with the Layer coverage check on that call.
  Both share the role loop and pool routing. A separate subpath keeps
  `@nmtjs/neem` out of the `/effect` entry that browser clients import.
- oxlint forbids `effect` imports in `packages/workflows/src` outside `src/effect`.

Existing tests moved to the adapter's imports; only tests of the changed API shapes
(runner options, shared-runtime typing, schema reuse from a definition) were edited. A new
Effect-free spec uses Zod and covers single and paired schemas, the compile-time
rejection of a lone transforming schema, stored JSON Schema, Promise handlers, the env type check,
parallel and map decoding, and the cleanup deadline.

Validation (`vp env exec`, unrestricted filesystem): workspace build, typecheck and
formatting passed; oxlint reports only the existing Deno warning; workflows **580
passed, 2 skipped**; preset **15** unit/type passed; live PostgreSQL 18 integration
**18 passed**. Neem and the preset e2e suites were not rerun: neither package
changed.

## Execution pools — 2026-09-21

Routing used to be declared away from the handlers: named execution pools listed
`activityNames`/`taskNames`, with one catch-all pool. A rename broke routing
silently, a handler could be claimed by no pool or by two, and an activity is named
after its node, so the claim's workflow-by-activity cross product could not route
two workflows' same-named nodes differently.

- **Only tasks and workflows carry placement.** `implementTask(task, { pool,
handler })` and `implementWorkflow(workflow, { pool })` require a pool; nothing
  is placed implicitly and there is no default pool. An activity is a private step
  of its workflow and runs on the workflow's pool. A step that needs its own pool
  is a task, which makes the decision visible in the contract. A per-activity pool
  was built first and removed: it needed exact `(workflow, activity)` claims and
  left shorthand cases with no way to name a pool.
- Workers claim by workflow and task names for their pool, so the cross product
  no longer matters: a workflow's activities all share its pool. The standalone
  execution worker takes `pool` instead of name lists. Routing stays worker-side
  rather than being stamped on commands: no migration, definitions stay free of
  deployment concerns, and moving an implementation reroutes already queued work.
- Pool size and timing are a deployment concern, so they moved from the shared
  config to `defineWorkflowsPlanner`, which now imports no application code and
  must declare every pool. It sends every thread its loop settings and the declared
  pool names.
- With the planner no longer reading it, `defineWorkflows` had no second reader
  and is removed. Each flavour's `defineWorkflowsWorker` takes one object: the
  registry plus `setup`, or plus `layer` and `runtime`. The env and Layer checks
  are unchanged.
- Validation moved from plan time to worker startup: an implementation naming an
  undeclared pool, or a workflow referencing an unregistered child or task, fails
  the thread's start. So does a name carried by more than one
  definition object. Children and tasks resolve by name, so a same-named copy would
  be encoded with one schema and decoded with another. It is also the only way to
  close a cycle, because definitions cannot reference each other as objects, so this
  check replaced a separate cycle detection. Implementations listed more than once
  are deduplicated by reference. Recurring work belongs to schedules.
- Pool concurrency is per-process capacity. Cluster-wide limits (named limits on
  tasks, runs in flight per workflow) are a separate, unbuilt slice. They would
  attach to tasks and workflows only, and a workflow's run limit must not count a
  child against a limit its waiting parent already holds.
- The README and the `use-neemata` workflows skill reference state the
  task-versus-activity rule; the skill reference was also brought up to date with
  Standard Schemas, `env` and the Effect adapter.

## Pubsub retained — 2026-09-21

The boundary above dropped pubsub "without a concrete requirement". The requirement
is distributed fanout for chat and live updates, and Effect `4.0.0-rc.116` does not
cover it: `effect/PubSub` is process-local; `unstable/persistence/Redis` exchanges
raw strings on a channel name, opens one Redis connection per `subscribe()` call, and
buffers each subscription in an unbounded queue. What the old package added was the
typed channel contract (params, named events, event selection), a broker-independent
adapter interface, and a Redis adapter that shares one subscriber connection per
process.

- `@nmtjs/pubsub` is restored from history with the same behaviour and the same
  shape as workflows: an Effect-free core and an optional-peer `/effect` adapter.
- Channel contracts moved into the package as `defineChannel`, since `contract` and
  `type` are gone. Params and payloads are Standard Schemas; a transformed payload
  declares `{ decode, encode }`, and a lone transforming schema is a compile error.
- The DI plugin and injectables are gone. `PubSubManager` takes an adapter and an
  optional Pino-compatible logger; `createRedisAdapter(client, logger?)` returns an
  initialized adapter that the caller disposes.
- `@nmtjs/pubsub/effect` defines channels from `effect/Schema` and provides a
  `PubSub` service: `publish` is an Effect, `subscribe` a Stream. It wraps the
  package's own adapter rather than Effect's unstable Redis module, which keeps
  connection sharing and the stable-modules-only rule. Effect awaits an iterator's
  `return()` when a stream's scope closes, which queues behind a pending `next()`;
  the adapter aborts the subscription first so an idle stream can be interrupted.
- Nothing was added beyond the previous behaviour. Buffering between the broker and
  a slow local subscriber is still unbounded; see [todo.md](todo.md).
