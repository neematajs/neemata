# Workflows Postgres-First Runtime Plan

## Goal

Pivot `@nmtjs/workflows` runtime from backend-agnostic adapter framing to a
Postgres-first durable runtime while keeping root contract/implementation
imports light.

## Decisions

- Postgres is the v1 durable runtime substrate, not one adapter among peers.
- Root `@nmtjs/workflows` exports remain dependency-light.
- New public runtime imports use:

  ```ts
  import { createPostgresWorkflowRuntime } from '@nmtjs/workflows/postgres'
  import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
  ```

- Drizzle is the primary migration artifact target. The runtime does not apply
  production migrations.
- Drizzle schema factory emits the canonical physical database object names used
  by the runtime. Custom physical names are deferred until the runtime can
  verify/query them too.
- `installPostgresWorkflowSchemaForTesting` stays explicit dev/test bootstrap.
- `verifyPostgresWorkflowSchema` is the production-safe startup check.

## Next Implementation Slices

### 1. Command Table Unification

- Add `workflow_command_kind` enum.
- Replace separate continue/activity/task command tables with one
  `workflow_commands` table.
- Keep command rows internal and workflow-specific; do not expose generic queue
  APIs.
- Claim with `FOR UPDATE SKIP LOCKED`.
- Keep `LISTEN/NOTIFY` optional latency hint only.

Status: implemented in the current WIP. The compatibility executor API remains,
but Postgres backs continuation, activity, and task commands with one
`workflow_commands` table.

### 2. Atomic Start

- Start workflow/task run and insert initial command in one transaction.
- Preserve idempotency conflict behavior.
- Notify after commit when notification support exists.

Status: implemented in the current WIP for explicit top-level starts. Postgres
runtime exposes an optional atomic start hook used by `createWorkflowRuntimeClient`;
generic store/executor starts remain as fallback for non-Postgres test runtimes.

### 3. Atomic Completion

- Complete/fail attempt, update node/map/child state, enqueue parent
  continuation, and ack/delete consumed command in one transaction.
- Duplicate or stale completions remain no-ops or explicit conflicts according
  to current store semantics.

Status: implemented in the current WIP for activity/task attempt success,
failure, and stale reconciliation paths. Postgres runtime exposes an optional
atomic completion hook used by activity/task workers; generic store/executor
completion remains as fallback for non-Postgres test runtimes.

### 4. Worker Loop

- Batch command claims.
- Support local concurrency per command kind.
- Recover expired leases.
- Add polling backstop.
- Add optional notify listener later, after polling path is correct.

Status: partially implemented. Workflow continuation now runs in a Postgres
transaction together with command ack/release, matching atomic start and atomic
attempt completion. Worker loops support local concurrency, abort signals,
bounded idle polling, and configurable idle delay. Batch claims and optional
notify remain.

### 5. Public Surface Cleanup

- Keep `@nmtjs/workflows/postgres` and `@nmtjs/workflows/postgres/drizzle` as
  preferred subpaths.
- Demote `createInMemoryWorkflowRuntime` to test/local helper if it remains.

Status: `WorkflowRuntimeClient` now exposes store-backed `list` for v1 run
queries. Package README documents the Postgres/Drizzle startup path and keeps
production migrations app-owned. Root `@nmtjs/workflows` exports are now limited
to dependency-light contract, implementation, and public graph/type helpers;
runtime helpers live under `@nmtjs/workflows/runtime`.

### 6. Child And Map Workflow Smoke

- Verify direct child workflow and `mapWorkflow(wait-all)` through real Postgres
  command dispatch and worker continuation.

Status: covered by a PGlite worker smoke test. Broader mode matrices stay in
the in-memory coordinator tests.

## Non-Goals

- No BullMQ/cloud queue runtime in v1.
- No generic queue send/work API.
- No production migration runner.
- No broad ORM abstraction.
