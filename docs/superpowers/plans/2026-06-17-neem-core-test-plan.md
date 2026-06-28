# Neem Core Real-World Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thoroughly test `@nmtjs/neem` core behavior with real build/dev/start flows, real worker threads, real manifests, and real filesystem/process boundaries.

**Architecture:** Keep tests at public/package boundaries wherever possible: CLI, built output, fixture apps, runtime workers, host runners, health/proxy endpoints, and manifest files. Unit tests stay for pure deterministic helpers; integration tests use real temp files/build output; e2e tests spawn actual Neem processes and do not mock Neem internals.

**Tech Stack:** TypeScript, Vitest, Node worker_threads, Rolldown, `@nmtjs/neem` CLI fixtures, JSONL/probe event harness.

---

## Scope

In scope:

- `packages/neem` public API, config/build graph/declaration resolution.
- manifest/artifact snapshot/start contract.
- runtime host, worker, health, proxy, recovery, services, CLI dev/build/start flow.
- current `packages/neem` unit, integration, and e2e harness.

Out of scope:

- Jobs, eventing, pubsub semantics. Their Neem adapters may be used only as examples/fixtures for generic host-only or runtime integration behavior.
- Regression tests asserting removed/old APIs do not exist.

## Baseline

- `pnpm --filter @nmtjs/neem exec vitest run --config vitest.config.ts tests/unit tests/integration`
  - Result: 10 files passed, 42 tests passed, no type errors.
- `pnpm test:neem`
  - Current result after implemented slices: unit 11 files / 43 tests passed; e2e 11 files / 64 tests passed; no type errors.
- `pnpm --filter @nmtjs/neem run test:stress`
  - Current result after opt-in stress suite: stress 2 files / 3 tests passed; no type errors.
  - Previous restricted-environment run failed in 6 watcher reload tests after initial ready; that failure is not reproducible under current permissions.
- Harness freshness risk addressed: package `test:e2e` now builds first and e2e runs through a dedicated serial Vitest config.

## Implementation Status

Implemented in this branch:

- Split unit/e2e Vitest configs and package scripts; e2e builds fresh `dist` first.
- Added process stop kill-after diagnostics, probe sequence/timestamp metadata, tolerant JSONL reading, and shared port helpers to the e2e harness.
- Added real CLI e2e coverage for outDir safety, declaration discovery/errors, production portability, manifest corruption/preflight, lifecycle timeouts, async worker factory, invalid upstreams, partial startup cleanup, SIGTERM shutdown, bare package entries, file URL entries, unsupported URL diagnostics, and external package/type consumer smoke.
- Added real CLI e2e coverage for recovery proxy/health behavior, reload-start-failure health/proxy safety, watcher broken-config rollback/stale-runtime artifact cleanup, watcher revision/hash rapid-change convergence, copied per-runtime production start, and copied host-only production start.
- Added opt-in stress suite for reload storms, repeated recovery loops, and bounded slow-stop shutdown behavior.
- Added product fixes for known-risk areas: validation before cleanup, known-output cleanup instead of whole outDir removal, selected-runtime manifest consistency, host runner request timeout, host runner failed-worker recovery cleanup, worker service request timeout, upstream validation, manifest shape validation, manifest file preflight, file-URL-only artifact entry diagnostics, recovery proxy upstream refresh, and dev config-invalidation rollback.

Remaining high-value gaps:

- Optional future hardening: abort-signal plumbing for lifecycle requests, deeper source-map stack assertions, and richer probe service/request-id metadata.

## Current Coverage

Good coverage already exists for:

- Public helpers: branding, frozen env, `createRuntime` merge behavior.
- Build graph target shape, selected runtime filtering, unknown runtime error.
- Rolldown merge precedence and sanitization.
- Manifest relative path validation, host-only manifest, generated start wrappers, selected manifest runtimes.
- Artifact registry scoped lookup.
- Runtime topology: array/grouped workers, host-only zero-thread runtime, invalid worker plan, structured-clone validation.
- Env precedence and freezing.
- Recovery policy, runtime selection helpers, shared utils, proxy helper normalization/options.
- E2E build/start/dev basics: manifest emission, production start not importing source config, generated runtime wrappers, graceful shutdown, config import isolation, health/ready probes, metrics, proxy, host/worker/logger/plugin reloads, plugin startup failure disposal, host/worker fail-once recovery, runtime selection, invalid manifest path.

Important coverage gaps:

- Declaration discovery through real CLI fixtures: glob/negation, folder convention, package name inference, duplicate names, missing planner, invalid default export, bare package specifiers, URL handling, CJS/MTS/CTS conventions.
- Failure cleanup: worker start throws before ready, host start throws before ready, multi-worker partial startup failure, hung planner/host start/host stop.
- Production portability: copy `dist` elsewhere, delete/poison source fixture, start copied output.
- Manifest corruption matrix with clean diagnostics.
- Recovery + proxy/health correctness during self-restart.
- Broken reload behavior and rollback contract.
- Real packaging/type consumer smoke.
- Harness resilience: stale dist, kill-after on hung stop, event sequencing, port allocation, JSONL partial-read tolerance.

## Ranked Breakage Risks

### P0

1. Unsafe output cleanup can delete valid deploy output before validation.
   - `buildNeem()` and `WatcherService.start()` call `cleanNeemOutDir(outDir)` before declaration resolution, graph creation, or compilation.
   - `cleanNeemOutDir()` currently removes the whole `outDir`.
   - Bad glob, duplicate runtime name, missing planner, resolver failure, or unsafe `--outDir .` can destroy prior output before failing.
   - Files: `packages/neem/src/internal/commands/build.ts`, `packages/neem/src/internal/services/watcher.ts`, `packages/neem/src/internal/build/clean.ts`.

2. E2E can validate stale `dist` instead of current source.
   - Unit tests import `src`, but e2e CLI spawns `bin/neem.js`, which resolves package export to `dist`.
   - This can block trust in `pnpm test:neem` unless package test builds first or e2e points at fresh compiled output.

### P1

1. Host runner RPC can hang forever.
   - `HostRunner.request()` has no timeout for `plan`, `start`, `stop`, or `shutdown`.
   - Hung planner/host start/host stop blocks start/reload/stop and can prevent worker cleanup.

2. Worker service normal requests can hang forever.
   - `WorkerServiceClient.request()` has no general timeout. Stop has timeout; start/reload do not.

3. Public async worker factory type is not honored.
   - `NeemRuntimeWorker.createRuntime` returns `MaybePromise<NeemRuntime>`, but worker entry assigns it directly and then calls `runtime.start()`.
   - Async `createRuntime()` will break at runtime.

4. Dev reload is non-transactional.
   - Full restart paths stop the old runtime before the new runtime proves healthy.
   - Broken plugin/logger/config edit can kill a previously working dev server.

5. `reloadRuntime()` has weak failure handling.
   - It marks server `reloading`, stops/deletes current runtime, starts next, then updates proxy.
   - If next start fails, state/proxy/failure hooks can be left inconsistent.

6. Recovery does not notify HostController/proxy of upstream changes.
   - `RuntimeController.recover()` restarts internally.
   - Proxy can keep stale upstreams when recovered workers bind new ports.

7. Readiness can lie during recovery.
   - `RuntimeController.stop()` clears `threads`; empty pool currently evaluates ready.
   - During recovery server can briefly appear ready with no live workers.

8. Watcher post-ready config errors are not a clear event path.
   - `watchConfigSignal()` rejects initial ready on error; after ready, `ready.reject()` is ineffective.
   - Broken config during dev needs structured error + recovery behavior.

9. Watcher changes lack revision/transaction identity.
   - Manifest write and event emit are async without a watcher-side queue/version in event payload.
   - Rapid changes can create stale or out-of-order reload decisions.

10. Runtime package name inference can walk to repo root.
    - Runtime folder without local `package.json#name` may inherit monorepo root package name.

11. URL contract is unclear.
    - Types allow `URL`; compiler later uses file-path conversion. Non-file URLs fail late.

12. Manifest validation is not schema validation.
    - Missing `config`, malformed plugins, missing nested fields, or wrong scalar types can throw raw errors or fail later.

13. Missing artifact files fail late.
    - Logger/plugin/host/planner/worker-entry file absence is discovered during import/worker startup, not preflight.

14. Selected build manifest can drift.
    - `build --runtime jobs` may emit only selected `manifest.runtimes` while `manifest.config.runtimes` still reflects full config.

15. Runtime upstream result shape is not validated.
    - Bad upstream `type` or invalid URL can poison proxy/health later.

### P2

1. Conventional runtime/planner discovery omits `.cts`/`.cjs` while resolver supports them elsewhere.
2. Planner target uses `declaration.host?.build?.rolldown`; there is no planner-specific build config, and host build settings may affect planner unexpectedly.
3. Global artifact registry `resolve(id)` returns first duplicate ID; runtime artifacts intentionally duplicate IDs.
4. Failure counters reset when recovered `ThreadController` instances are recreated.
5. Probe events lack pid, sequence, timestamp, service, request id, and revision fields.
6. `spawn.stop()` can wait forever; no kill-after or diagnostic dump on hung child.
7. Port allocation is TOCTOU: helper closes a free port before child binds.
8. JSONL reader is not tolerant of partial concurrent writes.
9. Source-map/runtime stack trace quality is not tested.
10. Packaging/published-layout type behavior is untested outside monorepo.

## Product/Testability Improvements Needed

- Add outDir safety before any cleanup:
  - Refuse cwd, repo root, home, filesystem root, and non-Neem dirs unless explicit force exists.
  - Prefer deleting known Neem outputs only: `start.js`, maps, `runtime`, `runtimes`, `config`, `neem.manifest.json`.
  - Or require a generated marker file before whole-directory cleanup.
- Validate config/declaration graph before cleanup.
- Make lifecycle timeouts configurable for tests and production:
  - planner, host start, host stop, host shutdown, worker start, worker stop, service request.
- Await async `createRuntime()`.
- Add request timeout/abort to `HostRunner` and `WorkerServiceClient`. Done for request timeout; abort-signal plumbing remains optional future hardening.
- Define reload contract:
  - transactional keep-old-runtime-on-failure, or explicit fail-fast with health/proxy cleanup.
- Add recovery lifecycle state and callback:
  - `recovering`, `runtime:recovered`, upstream change notification to HostController, proxy refresh after recovery.
- Validate runtime start result before sending `ready`.
- Add manifest schema parser/validator with explicit errors.
- Add production preflight verifying every manifest-referenced file exists before controller start.
- Decide URL contract: file URLs only or remote bundling. Fail early for unsupported URLs.
- Stop package-name search at config workspace root, or require explicit runtime name when nearest package is outside runtime project.
- Improve test probe/event schema with sequence, pid, service, request id, manifest revision, timestamp.
- Split e2e harness into process, fixture, events, ports, artifacts helpers.
- Make e2e serial by config, build before e2e, and add kill-after to child stop.

## Test Plan

### Task 1: Harness Freshness And Safety

**Files:**

- Modify: `packages/neem/package.json`
- Create: `packages/neem/vitest.e2e.config.ts`
- Create: `packages/neem/vitest.unit.config.ts`
- Create: `packages/neem/tests/e2e/harness/process.ts`
- Create: `packages/neem/tests/e2e/harness/events.ts`
- Create: `packages/neem/tests/e2e/harness/fixtures.ts`
- Create: `packages/neem/tests/e2e/harness/ports.ts`
- Create: `packages/neem/tests/e2e/harness/artifacts.ts`
- Modify: `packages/neem/tests/e2e/support/e2e.ts`

- [x] Add package scripts so e2e cannot run against stale `dist`.
  - `test:unit`: Vitest unit/integration only.
  - `test:e2e`: build first, then e2e.
  - `test`: unit + e2e, or a package `test:all` used by root `test:neem`.
- [x] Configure e2e serial execution.
- [x] Add process stop kill-after and diagnostic dump.
- [x] Add event sequence/timestamp helpers.
- [x] Add tolerant JSONL reader that handles partial trailing line.
- [x] Add artifact assertions: manifest path containment, file exists, importable where applicable.
- [x] Add port helper that can verify port reuse after stop/reload.
- [x] Re-run:
  - `pnpm --filter @nmtjs/neem run test:unit`
  - `pnpm --filter @nmtjs/neem run test:e2e`

### Task 2: OutDir Safety Tests And Product Fix

**Files:**

- Modify: `packages/neem/src/internal/build/clean.ts`
- Modify: `packages/neem/src/internal/commands/build.ts`
- Modify: `packages/neem/src/internal/services/watcher.ts`
- Create: `packages/neem/tests/e2e/specs/build-safety.spec.ts`

- [x] Add test: build failure preserves existing output when runtime glob matches no files.
- [x] Add test: unsafe `--outDir .` is refused and sentinel file remains.
- [x] Add test: config `outDir` pointing at fixture root is refused.
- [x] Implement cleanup guard and/or marker-based cleanup.
- [x] Move validation before cleanup where possible.
- [x] Verify with real CLI fixture, not direct internal mocks.

### Task 3: Declaration Discovery Real Fixtures

**Files:**

- Create: `packages/neem/tests/e2e/fixtures/cases/discovery/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/duplicate-runtime-name/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/missing-planner/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/bare-package-entry/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/url-entry/**`
- Create: `packages/neem/tests/e2e/specs/declaration-discovery.spec.ts`

- [x] Test glob + folder convention + negation through `neem build`.
- [x] Test package name inference from local runtime package.
- [x] Test duplicate explicit names fail with offending file path.
- [x] Test missing planner and planner-only-without-worker-or-host produce direct errors.
- [x] Test bare package worker/host/planner specifiers build and start.
- [x] Test file URL entries build and start.
- [x] Test non-file URL fails early with clear unsupported URL error.
- [x] Decide and test `.cjs/.cts` convention behavior.

### Task 4: Manifest And Production Portability

**Files:**

- Create: `packages/neem/tests/e2e/specs/production-portability.spec.ts`
- Create: `packages/neem/tests/e2e/specs/manifest-corruption.spec.ts`
- Modify: `packages/neem/src/internal/manifest/manifest.ts`
- Modify: `packages/neem/src/internal/manifest/snapshot.ts`
- Modify: `packages/neem/src/internal/standalone/entry.ts`

- [x] Build plugin/logger fixture, copy `dist` to a new temp dir, poison source, run copied `dist/start.js`.
- [x] Run copied per-runtime `dist/runtimes/api/start.js`.
- [x] Test production plugin options serialization.
- [x] Test host-only production wrapper.
- [x] Test corrupt manifest matrix:
  - invalid JSON.
  - missing `config`.
  - missing `runtime.worker.file`.
  - missing host/planner artifact fields.
  - missing logger module file.
  - missing plugin entry file.
  - malformed plugin object.
- [x] Test `build --runtime jobs` keeps `manifest.runtimes` and `manifest.config.runtimes` consistent.
- [x] Add schema validator and preflight where required.

### Task 5: Lifecycle Failure And Timeout Coverage

**Files:**

- Create: `packages/neem/tests/e2e/fixtures/cases/async-worker-factory/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/planner-hang/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/host-start-hang/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/host-stop-hang/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/start-failure-cleanup/**`
- Create: `packages/neem/tests/e2e/specs/lifecycle-failures.spec.ts`
- Modify: `packages/neem/src/internal/worker/entry.ts`
- Modify: `packages/neem/src/internal/host/runner.ts`
- Modify: `packages/neem/src/internal/services/client.ts`

- [x] Test async `createRuntime()` reaches ready.
- [x] Test hung planner times out and SIGTERM exits cleanly.
- [x] Test hung host start times out and cleans workers.
- [x] Test hung host stop does not hang child process forever.
- [x] Test multi-worker partial start failure stops already-started workers.
- [x] Test production `start` SIGTERM runs runtime stop, host stop, plugin dispose exactly once.
- [x] Implement await + timeout fixes.

### Task 6: Recovery, Health, Proxy Correctness

**Files:**

- Create: `packages/neem/tests/e2e/fixtures/cases/recovery-proxy/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/recovery-health/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/reload-start-failure/**`
- Create: `packages/neem/tests/e2e/fixtures/cases/bad-upstream/**`
- Create: `packages/neem/tests/e2e/specs/recovery-health-proxy.spec.ts`
- Modify: `packages/neem/src/internal/host/runtime.ts`
- Modify: `packages/neem/src/internal/host/controller.ts`
- Modify: `packages/neem/src/internal/host/proxy.ts`
- Modify: `packages/neem/src/internal/worker/entry.ts`

- [x] Test recovery to a new upstream port refreshes proxy routing.
- [x] Test `/ready` is 503 during recovery and 200 after recovered.
- [x] Test runtime reload start failure leaves health/proxy in explicit safe state and can recover after edit fix.
- [x] Test malformed upstream result fails startup with clear error.
- [x] Add recovery state/upstream notification and upstream validation.

### Task 7: Watcher And Dev Reload Semantics

**Files:**

- Create: `packages/neem/tests/e2e/specs/watcher-reload.spec.ts`
- Modify: `packages/neem/src/internal/services/watcher.ts`
- Modify: `packages/neem/src/internal/services/protocol.ts`
- Modify: `packages/neem/src/cli.ts`

- [x] Test broken config after initial ready emits structured watcher error and old runtime stays alive.
- [x] Test fixing config after broken edit restarts cleanly.
- [x] Test rapid worker + logger + plugin changes converge to latest manifest without stale reload.
- [x] Test stale artifacts are removed when a runtime is removed from config.
- [x] Test proxy survives config invalidation/reload on same port.
- [x] Add manifest revision/hash to watcher events.
- [x] Add transactional or explicitly fail-safe reload behavior.

### Task 8: Packaging And Type Smoke

**Files:**

- Create: `packages/neem/tests/e2e/specs/packaging.spec.ts`
- Create: `packages/neem/tests/e2e/fixtures/consumer/**`

- [x] Build/package or link `@nmtjs/neem` into a temp consumer outside the monorepo.
- [x] Typecheck imports of `defineConfig`, `defineRuntime`, `defineRuntimeWorker`, `InferNeemRuntimeWorkerData`.
- [x] Run consumer `neem build` and `node dist/start.js`.
- [x] Assert published `.d.ts` references resolve under normal NodeNext config.

### Task 9: Stress / Nightly Suite

**Files:**

- Create: `packages/neem/vitest.stress.config.ts`
- Create: `packages/neem/tests/stress/reload-storm.spec.ts`
- Create: `packages/neem/tests/stress/recovery-loop.spec.ts`

- [x] Rapid edit loop: worker/logger/plugin/config updates, assert final state only.
- [x] Repeated crash/recovery loop, assert no port leak and health returns ready.
- [x] Slow stop timeout path, assert probe events and bounded process exit.
- [x] Mark stress suite opt-in/nightly, not default PR gate.

## Suggested Execution Order

1. Fix harness freshness first. Complete.
2. Add outDir safety and preservation tests. Complete.
3. Fix async worker factory and lifecycle timeouts. Complete for host runner and worker service request timeout.
4. Add manifest schema/preflight and production portability tests. Complete for main start path, per-runtime start path, and host-only wrapper.
5. Add recovery/health/proxy tests and product corrections. Complete for worker self-recovery and proxy refresh.
6. Add watcher transactional/revision behavior. Complete.
7. Add packaging and stress suites. Complete.

## Self-Review

- Spec coverage: scope excludes jobs/eventing/pubsub semantics and focuses on Neem core.
- No placeholders: each task names files, behavior, and verification target.
- Test philosophy: real CLI/process/worker/build behavior; no mocking Neem internals.
- Known current blocker: none from current unrestricted run. Remaining work is optional future hardening, not a failing default or stress suite.
