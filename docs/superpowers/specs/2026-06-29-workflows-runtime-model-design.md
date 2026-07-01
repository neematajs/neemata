# Workflows Runtime Model Design

## Context

The public `@nmtjs/workflows` API now separates workflow declarations from
workflow implementations. Declarations describe the structural graph and schemas.
Implementations provide handlers and runtime mapping functions.

This spec defines the first runtime model for executing that API. The durable v1
runtime is Postgres-first: run state and internal command dispatch should be
persisted in the same database and advanced with transaction boundaries.

## Goals

- Keep Postgres workflow tables as the source of truth for workflow state.
- Treat queue commands as internal Postgres rows, not external durable state.
- Make state changes and dependent command inserts atomic whenever a split would
  create lost work.
- Resume runs from persisted run/node state without replaying arbitrary user
  JavaScript.
- Make duplicate, stale, and late completions safe.
- Support concurrency across many runs while allowing only one active
  coordinator per run.
- Support distributed worker pools where parent and child workflows can execute
  on different workers.
- Keep runtime behavior aligned with the v1 graph model: primitive leaves plus
  bounded orchestration nodes.

## Non-Goals

- Do not implement full event sourcing.
- Do not implement Temporal-style deterministic replay.
- Do not make BullMQ, Redis, Valkey, or cloud queues part of the v1 runtime.
- Do not expose generic queue APIs.
- Do not add signals, queries, timers, progress streams, or watch APIs in this
  runtime slice.
- Do not implement cancellation propagation in this runtime slice.
- Do not implement retry scheduling in this runtime slice.
- Do not support arbitrary nested subgraphs inside `branch` or `parallel`.

## Postgres Runtime Shape

The durable runtime is Postgres-backed:

```ts
import { createPostgresWorkflowRuntime } from '@nmtjs/workflows/postgres'
```

Postgres is not a generic adapter peer to BullMQ or cloud queues. It is the v1
runtime substrate: durable state, leases, delayed work, and continuation/attempt
commands should live in Postgres so runtime transitions can be atomic.

`createPostgresWorkflowRuntime()` accepts a small `WorkflowPostgresConnection`
interface instead of a concrete Postgres client so applications can adapt `pg`,
PGlite, Neon, Postgres.js, Kysely, Drizzle, or other query providers without
making the runtime depend on those libraries.
The runtime must not create or migrate schema implicitly. Applications should
apply schema through their own migration flow before constructing production
workers.

The Postgres adapter may expose explicit helpers for local/dev/test setup and
startup checks:

```ts
await installPostgresWorkflowSchemaForTesting(connection)
await verifyPostgresWorkflowSchema(connection)
```

`installPostgresWorkflowSchemaForTesting` is a convenience bootstrap helper for
tests and local development, not the recommended production migration path.
`verifyPostgresWorkflowSchema` is the production-safe startup check: it reads
catalog metadata and fails fast when required workflow objects are missing.
Required enums, tables, constraints, indexes, and schema version live in one
`WORKFLOW_POSTGRES_SCHEMA_MANIFEST` constant so verification and tests do not
maintain separate object lists.

Postgres schema compatibility is tracked by `workflow_schema_version`:

- singleton row: `id = 1`
- current version: `1`

`installPostgresWorkflowSchemaForTesting` inserts the current singleton version
row when it creates a fresh schema. `verifyPostgresWorkflowSchema` fails when the
row is missing or the stored version differs from the package's expected schema
version.

`@nmtjs/workflows/postgres/drizzle` exports Drizzle schema objects and a schema
factory for Drizzle-first migration integration. Applications still own
`drizzle-kit generate`, migration review, and migration execution.
The factory config controls physical database names only; application-local
TypeScript export names are owned by the app through normal aliases such as
`export const WorkflowRunTable = workflows.tables.runs`.
Finite workflow values should be represented as Postgres enums:

- run kind: `workflow`, `task`
- workflow node kind: `activity`, `task`, `workflow`, `branch`, `parallel`,
  `mapTask`, `mapWorkflow`
- run status: `queued`, `running`, `waiting`, `cancelling`, `cancelled`,
  `failed`, `completed`
- node/map-item status: `pending`, `running`, `waiting`, `cancelling`,
  `cancelled`, `failed`, `completed`
- attempt status: `started`, `completed`, `failed`, `timedOut`, `cancelled`
- command kind: `continue`, `activity`, `task`

Drizzle users must export both `workflows.enums.*` and `workflows.tables.*` from
their app-local schema wrapper so `drizzle-kit generate` emits `CREATE TYPE`
statements before enum-backed tables.

Postgres and Drizzle code must stay behind `postgres` subpaths so the root
package import does not pull infrastructure or migration-tool dependencies.
Existing `@nmtjs/workflows/adapters/postgres` paths are transitional
compatibility imports during the pivot and should not appear in new examples.

Postgres storage should use `uuid` columns for durable runtime IDs:

- run IDs
- attempt IDs
- parent/root/child run references
- current attempt references
- command IDs

Public TypeScript APIs still expose IDs as `string`; UUID is a Postgres adapter
storage choice, not root package vocabulary. Lease tokens may remain text even
when the adapter generates UUID-shaped tokens.

Postgres storage should use foreign keys for durable state relationships:

- nodes belong to runs
- attempts belong to nodes
- child links belong to parent nodes and child runs
- map item sets belong to nodes
- map items belong to map item sets and may point at child runs or attempts
- run leases belong to runs

State-owned relationships should cascade when the owning run/node/set is
removed. Optional observation pointers, such as current attempt or map item child
run/attempt references, may use `ON DELETE SET NULL`.

Command queue tables should carry first-class IDs for claim/lease behavior. Add
foreign keys only for identities that are real columns; payload-only identities
are not canonical state relationships.

## Internal Command Table

The v1 Postgres runtime should converge on one internal command table:

```txt
workflow_commands
  id uuid primary key
  kind workflow_command_kind not null
  run_id uuid not null
  workflow_name text null
  task_name text null
  activity_name text null
  node_name text null
  attempt_id uuid null
  payload jsonb not null default '{}'
  run_at timestamptz not null default now()
  priority integer not null default 0
  lease_owner text null
  lease_token text null
  lease_expires_at timestamptz null
  created_at timestamptz not null default now()
```

Command kinds:

- `continue`
- `activity`
- `task`

Rules:

- Claim commands with `FOR UPDATE SKIP LOCKED`.
- `LISTEN/NOTIFY` is optional latency hint only. Polling remains correctness
  layer.
- Claims should support batching and local concurrency.
- Lease expiry makes abandoned commands claimable again.
- A command row is internal plumbing, not public job state.

## Run Discovery

The runtime exposes run discovery over durable run state. The application-facing
client can wrap this later; the low-level shape should stay close to the
Postgres query model:

```ts
type ListRunsFilter = {
  kind?: RunKind
  name?: string
  status?: RuntimeRunStatus | readonly RuntimeRunStatus[]
  parentRunId?: string
  rootRunId?: string
  tags?: Readonly<Record<string, string>>
  input?: unknown
  limit?: number
  cursor?: string
}

type ListRunsResult = {
  runs: readonly StoredRun[]
  nextCursor?: string
}
```

Rules:

- Results are ordered newest first. Adapters must make rapid run creation
  deterministic without depending on UUID lexical order.
- `limit` caps returned rows; adapters may choose a default when omitted.
- `cursor` resumes from the previous result's `nextCursor`.
- `tags` use structural containment: every requested tag key/value must exist on
  the run.
- `input` uses structural JSON containment. For example,
  `input: { curriculumId: 'c1' }` matches runs whose stored input contains that
  object shape.
- No dot paths, regex, comparison operators, or arbitrary query language are in
  the v1 store contract.

The Postgres runtime should map `input` containment to JSONB containment:

```sql
input @> '{"curriculumId":"c1"}'::jsonb
```

Recommended Postgres indexes for the promised query shape:

```sql
CREATE INDEX workflow_runs_input_gin_idx
ON workflow_runs
USING gin (input jsonb_path_ops);

CREATE INDEX workflow_runs_tags_gin_idx
ON workflow_runs
USING gin (tags jsonb_path_ops);
```

Use GIN for JSON containment. GiST should not be introduced unless a concrete
query requires it.

## Source Of Truth

The runtime should use a store-owned state machine. Timeline entries are a
reserved future observability layer; the current store interface owns current
state and does not rebuild state by replaying a timeline.

Canonical persisted entities:

- `run`: task or workflow execution state
- `node`: workflow graph node state
- `attempt`: individual execution attempt state
- `childLink`: parent-to-child task/workflow run linkage
- `timeline`: planned append-only facts about important transitions

Command tables may contain duplicate commands. Command state is never
authoritative.

## Run State

A run represents one durable execution. The runnable can be a workflow or a
task:

- `workflow run`: durable coordinator for declared workflow graph nodes
- `task run`: durable execution of one task handler

Attempts are internal retry/lease records under a run. Public APIs and workflow
outputs should point at run IDs, not attempt IDs.

Run fields should include:

- run ID
- run kind: `workflow` or `task`
- runnable name
- status
- input
- output, when completed
- error, when failed or cancelled
- parent run ID, when started by a workflow node
- parent node name, when started by a workflow node
- root run ID
- tags
- idempotency key
- timestamps
- version or lock token

Run statuses:

```ts
type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
```

Rules:

- `completed`, `failed`, and `cancelled` are terminal.
- `waiting` means the run is blocked on pending work, retry delay, child runs,
  or map items.
- Retry is represented as waiting state plus retry metadata, not a public
  `retrying` status.
- Run updates must be versioned or locked so only one coordinator can advance a
  run at a time.

## Node State

A node represents one declared workflow graph node within a run.

Node fields should include:

- run ID
- node name
- node kind
- status
- persisted node input, when dispatchable
- node output, when completed
- error, when failed or cancelled
- selected branch case, for branch nodes
- map item snapshot, for map nodes
- current attempt ID, for primitive execution
- retry metadata
- timestamps
- version

Node statuses:

```ts
type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
```

Rules:

- Node input is computed once before dispatch and persisted.
- Retries reuse persisted node input unless an explicit future reset/rebuild
  operation exists.
- A node completion must be conditional on the expected attempt, child link, or
  map item version.
- Duplicate node completion is a no-op when the node is already terminal.

## Attempt State

An attempt represents one leased execution of a primitive task or activity.

Attempt fields should include:

- attempt ID
- run ID
- node name
- worker ID
- lease token
- status
- attempt number
- dispatch timestamp
- heartbeat timestamp
- completion timestamp
- output or error

Attempt statuses:

```ts
type AttemptStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'
```

Rules:

- Workers complete attempts with an attempt ID or lease token.
- Store ignores stale completions when the attempt is no longer current.
- Heartbeats and lease expiry are executor/store protocol concerns, not public
  workflow statuses.
- Retrying creates a new attempt record.

## Continuation Command

The runtime should use one coordinator command:

```ts
type ContinueRunCommand = {
  kind: 'continueRun'
  runId: string
  workflowName: string
}
```

`continueRun` carries no business data. It only means: something may have
changed, re-evaluate this run.

Continuation is enqueued after:

- workflow start
- activity completion
- task completion
- child workflow completion
- map item completion
- planned retry delay expiry
- planned cancellation propagation

Duplicate continuation commands are valid. The store lock/version makes
continuation idempotent.

Task completion only enqueues `continueRun` for a parent workflow when the task
run has parent metadata. A standalone task run can complete without a
coordinator continuation because it has no workflow graph to advance.

## Internal Executor Split

The current code splits dispatch interfaces by semantic role. This is useful
internally while the Postgres command runner is being built, but it should not be
presented as an app-facing backend extension API.

`RunCoordinationExecutor` owns continuation commands:

```ts
interface RunCoordinationExecutor {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Date): Promise<void>
  claim(worker: RunCoordinationWorkerClaim): Promise<ClaimedCommand | null>
  ack(command: ClaimedCommand): Promise<void>
  release(command: ClaimedCommand): Promise<void>
}
```

`AttemptExecutor` owns side-effecting activity attempts and task run attempts:

```ts
interface AttemptExecutor {
  dispatchActivity(command: ActivityAttemptCommand): Promise<void>
  dispatchTask(command: TaskAttemptCommand): Promise<void>
  claimActivity(worker: ActivityWorkerClaim): Promise<ClaimedAttempt | null>
  claimTask(worker: TaskWorkerClaim): Promise<ClaimedAttempt | null>
  heartbeat(attempt: ClaimedAttempt): Promise<void>
  ack(attempt: ClaimedAttempt): Promise<void>
  release(attempt: ClaimedAttempt): Promise<void>
}
```

Rules:

- `RunCoordinationExecutor` commands are idempotent run pokes. They carry no
  business payload and may be duplicated or coalesced by `runId`.
- `AttemptExecutor` commands are leased work attempts. They have attempt
  identity, heartbeat/timeout behavior, and output/error completion.
- Coordination claims are filtered by workflow name.
- Activity claims are filtered by workflow name and activity name.
- Task claims are filtered by task name. A task attempt belongs to a durable
  task run; the attempt ID is not a public run handle.
- The Postgres runtime may implement both roles with one command table, but the
  code can keep separate internal functions/types where it keeps coordinator
  and attempt semantics clearer.

## Continuation Worker

The orchestration worker consumes `continueRun` commands.

Per command, it should:

1. Acquire the run lock or version guard.
2. Load run, node, attempt, child link, and map item state needed to advance.
3. Exit if the run is terminal.
4. Validate that the worker has the workflow implementation for `workflowName`.
5. Evaluate the next graph node or blocked node state.
6. Persist any deterministic control decision, such as selected branch case or
   map item snapshot.
7. Compute and persist node input before dispatching external work.
8. Dispatch activity attempts, child task run starts, or child workflow starts.
9. Mark the run `waiting` if no more local progress is possible.
10. Run `finish` and mark the run `completed` when all nodes are complete.
11. Acknowledge or release the consumed continuation command.
12. Release the run lock.

For the Postgres runtime, steps that mutate run/node/attempt/child/map state,
insert follow-up commands, and acknowledge/release the consumed continuation
command should happen in one transaction. If command acknowledgement fails, graph
state changes roll back with it.

The continuation worker executes mapper functions:

- node `input`
- branch `select`
- map `items`
- map item `input`
- `finish`

These functions must be fast coordinator logic. They can use workflow-scoped
dependencies, but they must not perform heavy side effects. If data must come
from a database, API, LLM, storage service, or other side-effect boundary, a
previous task or activity should produce that data.

## Concurrency

Concurrency is required, but it is concurrency across runs, not within one run
coordinator.

Low-level worker API allows orchestration concurrency:

```ts
runWorkflowWorker({
  workflows: [curriculumWorkflowImpl, caseWorkflowImpl],
  runtime,
  container,
  workerId: 'workflow-worker-1',
  concurrency: 20,
})
```

Rules:

- `concurrency` means max simultaneous `continueRun` evaluations per worker
  process.
- Only one continuation may hold the lock for a single run at a time.
- Different runs may advance concurrently.
- Multiple worker processes may share the same workflow set.
- Queue adapters may coalesce `continueRun(runId)` commands, but runtime must
  not depend on coalescing.

Attempt workers should have separate concurrency:

```ts
runActivityWorker({
  workflows: [caseWorkflowImpl],
  runtime,
  container,
  workerId: 'activity-worker-1',
  concurrency: 50,
})

runTaskWorker({
  tasks: [embeddingTaskImpl],
  runtime,
  container,
  workerId: 'task-worker-1',
  concurrency: 50,
})
```

This separates:

- orchestration concurrency: how many runs can be advanced at once
- activity execution concurrency: how many workflow-local activity attempts can
  execute at once on workers that registered the workflow implementation
- task execution concurrency: how many reusable task run attempts can execute at
  once on task workers

## Worker Registration And Routeability

Workflow workers register workflow implementations. Task workers register task
implementations. A parent workflow implementation acknowledges child workflow and
task declarations, but it does not import their implementations just to execute
the parent graph.

Example deployment:

```ts
runWorkflowWorker({
  workflows: [curriculumWorkflowImpl],
  runtime,
  container,
  workerId: 'curriculum-worker',
  concurrency: 10,
})

runActivityWorker({
  workflows: [caseGenerationWorkflowImpl],
  runtime,
  container,
  workerId: 'case-activity-worker',
  concurrency: 100,
})

runTaskWorker({
  tasks: [embeddingTaskImpl],
  runtime,
  container,
  workerId: 'embedding-worker',
  concurrency: 100,
})
```

Rules:

- `continueRun` includes `workflowName`.
- A worker should only claim commands for registered workflow names when the
  adapter can filter claims.
- If an adapter cannot filter before claim, unsupported commands must be
  rejected, released, or requeued without changing run state.
- Runtime assembly validates that every runnable referenced by registered
  workflow implementations is routeable in the deployment.
- Workflow-local activity handlers are routeable through workers that registered
  the owning workflow implementation.
- Parent workflow A may start child workflow B even when worker A does not have
  B's implementation. B advances on a worker registered for B.
- Parent workflow A may start child task T even when worker A does not have T's
  implementation. T executes on a task worker registered for T.

## Primitive Node Semantics

Primitive nodes perform or start work outside the coordinator.

### Standalone Task Start

A top-level task start creates a durable task run, then dispatches one internal
task attempt through `AttemptExecutor`.

Behavior:

- Create run with `kind: 'task'`, runnable name, decoded input, tags, and
  idempotency key.
- Create the task run's internal task node.
- Persist task input before dispatching the attempt.
- Dispatch task attempt by task name.
- Task worker completes or fails the attempt.
- Task worker completes or fails the task run.
- If the task run has parent metadata, enqueue parent `continueRun`; otherwise
  no workflow continuation is needed.

Rules:

- Standalone task start returns the task run ID.
- Task run ID is the public handle for `get`, `list`, and `cancel`.
- Attempt ID is internal retry/lease state.
- Standalone task execution does not require a workflow implementation or
  workflow coordinator worker.

### Activity

- Compute and persist activity input.
- Create an attempt.
- Dispatch the attempt to an activity-capable executor.
- Mark node `running`.
- On attempt completion, store completes the node and enqueues `continueRun`.

Activities are workflow-local side-effect boundaries.

### Task

- Compute and persist task input.
- Persist child task run/link before dispatching task execution.
- Dispatch task run through the task executor.
- Mark parent node `waiting`.
- Child task terminal state enqueues parent `continueRun`.
- Parent node completes from child task output.
- Enqueue `continueRun`.

Tasks are reusable startable units. A workflow task node is represented as a
parent workflow node plus a durable child task run. Task attempts are internal to
that child task run.

### Workflow

- Compute and persist child workflow input.
- Persist `childLink` before dispatching child start.
- Start child run keyed by structured parent child identity. Current runtime
  evaluates implementation-owned idempotency callbacks and persists the computed
  key on child task/workflow runs.
- Mark parent node `waiting`.
- Child terminal state enqueues parent `continueRun`.
- Parent node completes from child output.

Duplicate child-start attempts must resolve to the existing child run for the
same parent run and node.

## Orchestration Node Semantics

Orchestration nodes are store-visible control nodes evaluated by the
continuation worker. They do not get independent worker leases unless they
dispatch primitive work.

### Branch

- Evaluate `select`.
- Persist selected case.
- Execute exactly one primitive case: activity, task, or workflow.
- Branch node output is the selected case output.
- If the declaration has explicit branch output, cases must converge to that
  output.
- If the declaration omits branch output, branch output may be a union of case
  outputs.

### Parallel

- Start all named primitive cases that are not already started.
- Track each case independently.
- Mark the parallel node `waiting` until required cases finish.
- Complete with an object keyed by parallel case name.
- Failure policy is fail-fast for v1 unless the public API adds explicit settled
  behavior later.

### Map Task

- Evaluate `items` once.
- Persist the item snapshot with stable item index and optional item key.
- Start one child task run per item.
- For `wait-all` and `wait-settled`, node-level `concurrency` bounds active
  child task runs.
- For `start-only`, node-level `concurrency` bounds how many child task links
  are started per continuation pass. The parent enqueues another continuation
  until all child links are persisted.
- Track each child task run independently.
- Complete according to mode:
  - `wait-all`: all items must complete successfully
  - `wait-settled`: collect success and failure records
  - `start-only`: complete after child task run links are persisted

### Map Workflow

- Evaluate `items` once.
- Persist the item snapshot with stable item index and optional item key.
- Persist one child link per item before child dispatch.
- Start one child workflow run per item.
- For `wait-all` and `wait-settled`, node-level `concurrency` bounds active
  child workflow runs.
- For `start-only`, node-level `concurrency` bounds how many child workflow
  links are started per continuation pass. The parent enqueues another
  continuation until all child links are persisted.
- Track each child run independently.
- Complete according to mode:
  - `wait-all`: all children must complete successfully
  - `wait-settled`: collect success and failure records
  - `start-only`: complete after child links are persisted

## Planned Cancellation Semantics

Cancellation is not implemented in the current runtime slice. The intended model
is:

Cancellation starts as a run transition to `cancelling`.

Rules:

- Continuation propagates cancellation to running attempts and child links.
- Parent workflow cancellation propagates to child workflows by default.
- Nodes move to `cancelling` while propagation is in flight.
- Run becomes `cancelled` only after active nodes are cancelled or have reached
  a terminal state.
- Late completions after cancellation are ignored unless they match still-active
  attempts.

## Planned Retry Semantics

Retry scheduling is not implemented in the current runtime slice. The intended
model is node-level retry.

Rules:

- Failed attempts update attempt state and node retry metadata.
- If retry is allowed, node becomes `waiting` with `nextAttemptAt`.
- Executor enqueues delayed `continueRun` for `nextAttemptAt`.
- Continuation creates the next attempt using persisted node input.
- If retry is exhausted, node becomes `failed` and run failure propagates
  according to node semantics.

Workflow-level retry remains out of scope.

## Postgres Runtime Responsibilities

Durable state storage provides:

- versioned run updates or locks
- one active coordinator lease per run
- expired coordinator lease reclaim
- stale lease release no-op behavior
- node state persistence
- attempt persistence
- child link persistence
- run idempotency enforcement:
  - duplicate `createRun` with same runnable identity, same input, and same
    idempotency key returns the existing run
  - duplicate `createRun` with the same idempotency key but different runnable
    identity or input fails with an explicit conflict
- child link atomicity:
  - duplicate child identity returns the existing link/run when child kind,
    child name, input, and idempotency key match
  - duplicate child identity with different child kind, child name, input, or
    idempotency key fails with an explicit conflict
- map item atomicity:
  - duplicate keys in one `ensureMapItems` call fail
  - repeated `ensureMapItems` with the same keys and same item payloads returns
    existing items
  - repeated `ensureMapItems` with same keys but different item payloads fails
    with an explicit conflict
- stale, wrong-token, and duplicate terminal attempt completion rejection
- terminal node/run update no-op behavior
- snapshot isolation: `loadRunSnapshot(runId)` returns only that run's nodes,
  attempts, child links, and map items
- run discovery with kind, name, status, parent/root, tag containment, input
  containment, and cursor pagination filters

Run coordination command implementation provides:

- command enqueue
- delayed command enqueue
- continuation command claim/release/ack
- release requeues a claimed continuation command
- ack removes a claimed continuation command
- workflow-name filtering where the command query can support it

Attempt command implementation provides:

- activity attempt dispatch
- task run attempt dispatch
- activity claim filtering by workflow name and activity name
- task claim filtering by task name
- attempt claim/release/ack
- release requeues a claimed attempt command
- ack removes a claimed attempt command
- worker leasing
- heartbeat support without changing claim ownership
- heartbeats or lease expiry, where needed for concrete infrastructure
- concurrency limits

Postgres may implement both command roles with one table and separate internal
claim paths. The root package must not import Postgres code; the durable runtime
subpath owns that dependency boundary.

## Design Guardrails

- If a queue loses a command, store state should make recovery possible through
  scanning or delayed continuation repair.
- If a queue duplicates a command, continuation must remain idempotent.
- If a worker crashes after dispatch but before ack, retry must not create an
  invalid duplicate node completion.
- If a child workflow starts but parent continuation crashes, persisted
  `childLink` must let the parent resume waiting for that child.
- If a mapper needs side effects, make the side effect a task or activity.
- If a worker lacks a workflow implementation, it must not partially advance
  that workflow run.

## Acceptance Criteria

- Starting a workflow creates a run and enqueues `continueRun`.
- Every primitive completion enqueues `continueRun`.
- Coordination and execution dispatch are represented by separate executor
  interfaces.
- Duplicate continuation commands cannot corrupt run or node state.
- Only one coordinator can advance a specific run at a time.
- Multiple coordinators can advance different runs concurrently.
- Node inputs are durable before external work is dispatched.
- Attempts are explicit and stale completions are ignored.
- Parent and child workflows can be handled by different worker pools.
- Map nodes support item snapshots and bounded per-node concurrency.
- Runtime can execute through store and executor interfaces without adapter
  dependencies.
