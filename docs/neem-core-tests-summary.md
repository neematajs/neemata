# Neem Core Tests: Findings And Coverage Summary

Date: 2026-06-17

Scope: `@nmtjs/neem` core only. Jobs, eventing, pubsub semantics excluded except as generic fixture behavior where needed.

## Verification Snapshot

Latest verified commands:

- `pnpm --filter @nmtjs/neem run check:type` passed.
- `pnpm test:neem` passed.
  - Unit/integration: 11 files, 43 tests.
  - E2E: 11 files, 64 tests.
- `pnpm --filter @nmtjs/neem run test:stress` passed.
  - Stress: 2 files, 3 tests.

Important environment note:

- Previous watcher reload e2e timeout happened only under restricted filesystem/sandbox permissions.
- Under unrestricted permissions, full `pnpm test:neem` passed.
- Project instruction now says to treat that specific restricted-permission failure as environment limitation unless reproduced outside sandbox.

## Coverage Added

### Harness And Test Freshness

Added:

- Dedicated unit/e2e/stress Vitest configs.
- `test:e2e` now builds package first, preventing stale `dist` validation.
- E2E serial execution.
- Child-process kill-after diagnostics.
- Probe event `pid`, `sequence`, `timestamp`.
- Tolerant JSONL reader for partial trailing writes.
- Shared port/artifact helpers.

Coverage value:

- E2E now exercises current compiled Neem CLI, not old package output.
- Hung child shutdowns produce actionable diagnostics instead of silent test hangs.
- Watcher/reload tests can assert event order and final convergence.

### Build And OutDir Safety

Added real CLI tests for:

- Failed declaration/build validation preserving existing output.
- Unsafe `--outDir .` refusal.
- Config `outDir` pointing at fixture root refusal.
- Cleanup of known Neem outputs instead of whole output-dir deletion.

Product fixes:

- Build graph validation moved before cleanup where possible.
- Cleanup no longer removes arbitrary outDir contents.
- OutDir equal to config dir is refused.

Coverage value:

- Main data-loss risk is now covered by real filesystem fixtures and real CLI runs.

### Declaration Discovery

Added real CLI fixture coverage for:

- Glob discovery.
- Negation patterns.
- Folder/package convention discovery.
- Local package-name inference.
- Duplicate runtime names with useful file-path diagnostics.
- Missing planner.
- Planner-only without worker/host.
- Bare package entrypoints.
- File URL entrypoints.
- Non-file URL early failure.
- `.cjs`/`.cts` conventional runtime/planner discovery.

Product fixes:

- Resolver handles more convention cases.
- Unsupported non-file URLs fail early.
- Duplicate/missing declaration errors are explicit.

Coverage value:

- Discovery behavior is now tested through package boundary, not internal resolver mocks.

### Manifest And Production Portability

Added tests for:

- Built app copied to separate temp dir.
- Source fixture poisoned/deleted after build.
- Copied `dist/start.js` still starts.
- Copied per-runtime `dist/runtimes/<runtime>/start.js` still starts.
- Host-only production wrapper.
- Plugin/logger option serialization.
- Corrupt manifest matrix:
  - invalid JSON.
  - missing `config`.
  - missing worker file.
  - missing host/planner artifact fields.
  - missing logger module file.
  - missing plugin entry file.

Product fixes:

- Manifest shape validation.
- Manifest file preflight before runtime start.
- Selected-runtime manifest consistency.
- Host-only and per-runtime production wrappers hardened.

Coverage value:

- Production startup now proves it does not depend on source tree or monorepo layout.

### Lifecycle Failure Paths

Added real process/worker coverage for:

- Async worker factory.
- Host runner request timeout.
- Worker service request timeout.
- Invalid upstream result validation.
- Hung planner.
- Hung host start.
- Hung host stop.
- Worker start failure before ready.
- Multi-worker partial startup cleanup.
- Production SIGTERM shutdown exactly once.

Product fixes:

- Async worker factory awaited.
- Host runner request timeout added.
- Worker service request timeout added.
- Invalid upstreams rejected.
- Failed-worker cleanup race fixed.

Coverage value:

- Start/reload/stop failure modes now have bounded behavior and cleanup assertions.

### Recovery, Health, Proxy

Added e2e coverage for:

- Recovered upstream refreshes proxy target.
- `/ready` returns unavailable during recovery.
- `/ready` returns healthy after recovery.
- Reload-start failure removes partial upstream.
- Explicit unavailable state is preserved after failed reload.
- Later edit can recover to healthy runtime.

Product fixes:

- Recovery now refreshes proxy upstreams.
- Runtime health state reflects recovery/unavailable windows.
- Failed reload keeps host/proxy state coherent enough for later recovery.

Coverage value:

- Proxy/health correctness is verified across real worker restarts, not by isolated controller calls.

### Watcher Reload Contract

Added e2e coverage for:

- Broken config edit rolls back to old runtime/proxy.
- Structured watcher error event.
- Stale runtime artifacts removed.
- Watcher events include manifest file, revision, hash.
- Rapid worker/logger/plugin edits converge to latest behavior.
- Manifest writes are queued through operation ordering.

Product fixes:

- Dev config invalidation rollback.
- Watcher event metadata.
- Reload/event sequencing hardened.

Coverage value:

- Dev server behavior is now tested as a transaction: bad edit should not destroy working app, good later edit should recover.

### Packaging And Public Type Surface

Added external consumer smoke:

- Staged package installed into temp consumer.
- NodeNext typecheck passes for public imports:
  - `defineConfig`.
  - `defineRuntime`.
  - `defineRuntimeWorker`.
  - `InferNeemRuntimeWorkerData`.
- Consumer build/start succeeds.
- Published `.d.ts` paths checked.

Known limitation:

- `pnpm pack` currently fails with `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND` because package metadata lacks version.
- Test uses staged publish-like manifests instead of real `pnpm pack`.

Coverage value:

- Public package surface gets checked outside monorepo assumptions.

### Stress Suite

Added opt-in `test:stress`:

- Reload storm convergence.
- Repeated crash/recovery loop.
- Slow stop bounded exit.

Coverage value:

- High-cost instability checks exist without slowing default package tests.

## Main Findings

### Fixed P0/P1 Risks

- E2E stale-dist risk: fixed by build-before-e2e split.
- Unsafe output cleanup: fixed by validation-before-cleanup and known-output cleanup.
- Hung lifecycle calls: bounded by request timeouts.
- Async worker factory mismatch: runtime creation now awaited.
- Recovery/proxy stale upstream: proxy refresh covered and fixed.
- Readiness during recovery: explicit unavailable window covered.
- Broken dev reload killing working runtime: rollback behavior covered.
- Manifest corruption late/raw failures: validation/preflight covered.
- Selected runtime manifest drift: consistency covered.

### Still Worth Future Hardening

- Add abort-signal plumbing to lifecycle requests, not only request timeouts.
- Add deeper source-map stack assertions for production runtime failures.
- Add richer probe metadata for service/request IDs.
- Decide whether real `pnpm pack` should be unblocked by adding proper package version metadata.
- Consider broader unsafe outDir refusal policy: cwd, repo root, home, filesystem root, non-Neem dirs.
- Keep stress suite opt-in unless CI capacity allows regular execution.

## Current Test Inventory

Core package scripts:

- `pnpm --filter @nmtjs/neem run test:unit`
- `pnpm --filter @nmtjs/neem run test:e2e`
- `pnpm --filter @nmtjs/neem run test:stress`
- `pnpm test:neem`

New/expanded e2e specs:

- `build-safety.spec.ts`
- `declaration-discovery.spec.ts`
- `declaration-errors.spec.ts`
- `harness.spec.ts`
- `lifecycle-failures.spec.ts`
- `manifest-corruption.spec.ts`
- `packaging.spec.ts`
- `production-portability.spec.ts`
- `recovery-health-proxy.spec.ts`
- `watcher-reload.spec.ts`

New/expanded unit/stress specs:

- `services-client.spec.ts`
- `stress/reload-storm.spec.ts`
- `stress/recovery-loop.spec.ts`

## Coverage Assessment

Coverage is now strong for real-world Neem core behavior:

- Public CLI build/dev/start flows.
- Real built artifacts.
- Real temp fixture apps.
- Real worker threads.
- Real manifests.
- Real proxy/health endpoints.
- Real process shutdown.
- Real external consumer package use.

Weakest remaining areas:

- Exact stack/source-map quality.
- Abort semantics beyond timeout behavior.
- Package publishing via real `pnpm pack`.
- Long-running stress beyond current compact opt-in suite.

Bottom line:

- Neem core test coverage moved from mostly helper/controller confidence to real package-boundary confidence.
- Biggest breakage classes now have concrete regression tests.
- Remaining gaps are hardening/observability, not primary correctness coverage.
