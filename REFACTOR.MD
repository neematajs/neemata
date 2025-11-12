# Neemata Runtime Refactor Plan

## Goals
- Make `packages/application` a thin orchestration facade responsible only for plugin wiring, container setup, and registry exposure.
- Centralize execution concerns (commands, jobs, transports, lifecycle) within `packages/runtime` so workers and tooling rely on a single orchestration surface.
- Operate a single gateway instance that multiplexes transports and routes calls to appropriate application contexts.
- Preserve current developer ergonomics (Vite-driven dev workflow, bundlable prod entry) while modernizing architecture.
- Remove legacy compatibility shims and unused exports to simplify public API.

## High-Level Architecture
- **Runtime Orchestrator**: New `Runtime` in `packages/runtime` that owns app loading, container lifecycles, plugin execution, gateway composition, command/job execution, and lifecycle hooks. The runtime maintains a root container for global injectables, forks children per app instance, and constructs the single gateway via `packages/gateway`.
- **Application Layer**: `Application` shrinks into a service descriptor (router + filters + lifecycle hooks) that delegates execution concerns to the runtime while keeping only minimal wrappers for compatibility.
- **Gateway**: Single runtime-managed instance. Runtime supplies transport descriptors, identity resolver, and per-app routing metadata. Maintains existing host APIs for dev/prod entrypoints.
- **Workers/Server**: Worker pool and job processing infrastructure (`runtime/src/server.ts`, `runtime/src/worker.ts`) consume runtime orchestrator APIs instead of touching application internals directly.
- **Configuration**: Runtime config becomes the authoritative schema describing applications, transports, workers, and queue/scheduler setup. Application config adapts or proxies to the runtime schema during transition.

## Workstreams & Tasks

### 1. Runtime Orchestrator
- [ ] Design runtime service interface (initialization, start/stop, app registration, gateway bootstrap, command/job access).
- [ ] Implement orchestrator in `packages/runtime/src/runtime.ts` (or similar) consolidating container creation, registry management, lifecycle hooks, and plugin handling.
- [ ] Initialize a runtime-owned root container for global injectables and expose forked containers when instantiating apps.
- [ ] Adapt existing `defineApplication` factories so the runtime captures per-app metadata (type, transports, commands, jobs) previously handled in the application layer.
- [ ] Update runtime exports (`runtime/src/index.ts`) to expose the orchestrator and supporting types.

### 2. Commands Relocation
- [ ] Move command types and execution logic from `packages/application/src/commands.ts` into runtime (e.g., `runtime/src/commands.ts`).
- [ ] Introduce runtime-level registration APIs that feed into the orchestrator-managed registry.
- [ ] Adjust any references (workers, CLI stubs, plugins) to import from runtime instead of application.

### 3. Job Runner Consolidation
- [ ] Merge `packages/application` job runner remnants with `runtime/src/jobs/*`, making runtime the single owner of job execution primitives.
- [ ] Ensure `ApplicationWorkerJobRunner` extends the new base runner and hooks into runtime lifecycle hooks/registry.
- [ ] Update job registration APIs and types to align with runtime orchestrator.

### 4. Application Class Thinning
- [ ] Strip transport/job/command startup logic from `packages/application/src/application.ts`, delegating to runtime service.
- [ ] Keep container, registry, plugin initialization as thin wrappers or adaptors; expose runtime handles (`pubsub`, `hooks`, etc.) via dependency injection as needed.
- [ ] Adjust `application/src/index.ts` exports to re-export runtime components where appropriate and remove deprecated symbols.
- [ ] Rework application config/types to reflect "service" semantics (router, filters, lifecycle hooks) and clarify documentation.

### 5. Gateway Integration
- [ ] Define runtime-owned gateway bootstrap that instantiates the single `Gateway` with transport descriptors from config.
- [ ] Wire gateway lifecycle (start/stop) through orchestrator, ensuring connection contexts resolve against the right app containers.
- [ ] Revisit identity resolver and transport worker signatures to source dependencies from runtime-managed containers.
- [ ] Preserve dev/prod entry flows: supply Vite dev entry that calls new bootstrap, and update production bundle entry accordingly.
- [ ] Expose gateway instance construction on the runtime so other subsystems (CLI, server) pull from a single creation path.

### 6. Configuration & Bootstrapping
- [ ] Redesign runtime config schema (`runtime/src/config.ts`) to describe apps, transports, workers, scheduler, redis.
- [ ] Provide helper functions (e.g., `defineRuntime`, `defineApp`) and update application config to delegate into the new schema.
- [ ] Update worker/server entrypoints to consume new config shapes, including per-worker overrides and application-specific options.
- [ ] Add configuration for per-application worker assignment (e.g., pin apps to specific API worker counts or slots).

### 7. Worker & Server Update
- [ ] Refactor `runtime/src/server.ts` and `runtime/src/worker.ts` to initialize apps via runtime orchestrator, not direct `Application` instances.
- [ ] Ensure job execution paths use relocated command/job services and runtime-controlled lifecycle signals.
- [ ] Simplify queue interaction logic using the new runtime registry interfaces.

## Sequencing Notes
- Prioritize orchestrator implementation, command/job relocation, and application thinning before touching gateway/worker to minimize breakage.
- After each major move, ensure compilation succeeds; defer comprehensive test rewrites until post-refactor stabilization.
- Coordinate config schema changes with gateway bootstrap work to avoid repeated rewrites of entrypoints.
- Post-refactor backlog (dependency/build cleanups, docs, observability) lives in `POST-REFACTOR.md`.

## Open Decisions / Follow-Ups
- Define the configuration model for per-application worker placement (counts, pinning, scheduling semantics) before implementing Workstream 6.

*Tests will be addressed in later stages; focus now is on architecture and implementation refactor.*
