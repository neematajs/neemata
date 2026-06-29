# Workflows Runtime Model Design

## Context

The public `@nmtjs/workflows` API now separates workflow declarations from
workflow implementations. Declarations describe the structural graph and schemas.
Implementations provide handlers and runtime mapping functions.

This spec defines the first runtime model for executing that API. It intentionally
does not define final database tables or adapter code.

## Goals

- Keep the store as the source of truth for workflow state.
- Treat queues and workers as dispatch details, not durable state.
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
- Do not define final SQL schema details.
- Do not define adapter-specific APIs for BullMQ, Redis, Valkey, Postgres, or
  cloud queues.
- Do not add signals, queries, timers, progress streams, or watch APIs in this
  runtime slice.
- Do not implement cancellation propagation in this runtime slice.
- Do not implement retry scheduling in this runtime slice.
- Do not support arbitrary nested subgraphs inside `branch` or `parallel`.

## Source Of Truth

The runtime should use a store-owned state machine with an append-only timeline.
The store owns current state. Timeline entries are facts for debugging,
observability, and future UI, but runtime does not rebuild state by replaying the
timeline.

Canonical persisted entities:

- `run`: task or workflow execution state
- `node`: workflow graph node state
- `attempt`: individual execution attempt state
- `childLink`: parent-to-child task/workflow run linkage
- `timeline`: append-only facts about important transitions

Queues may contain duplicate commands. Queue state is never authoritative.

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
- retry delay expiry
- cancellation propagation

Duplicate continuation commands are valid. The store lock/version makes
continuation idempotent.

Task completion only enqueues `continueRun` for a parent workflow when the task
run has parent metadata. A standalone task run can complete without a
coordinator continuation because it has no workflow graph to advance.

## Executor Split

The runtime should split dispatch interfaces by semantic role.

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
- Activity claims are filtered by workflow name and activity node name.
- Task claims are filtered by task name. A task attempt belongs to a durable
  task run; the attempt ID is not a public run handle.
- The core runtime may use one adapter package to implement both interfaces, but
  the interfaces stay separate.

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
11. Release the run lock.

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

Worker API should allow orchestration concurrency:

```ts
createWorkflowWorker({
  workflows: [curriculumWorkflowImpl, caseWorkflowImpl],
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
createWorkflowWorker({
  workflows: [caseWorkflowImpl],
  concurrency: 20,
  activityConcurrency: 50,
})

createTaskWorker({
  tasks: [embeddingTaskImpl],
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
createWorkflowWorker({
  workflows: [curriculumWorkflowImpl],
  concurrency: 10,
})

createWorkflowWorker({
  workflows: [caseGenerationWorkflowImpl],
  concurrency: 50,
  activityConcurrency: 100,
})

createTaskWorker({
  tasks: [embeddingTaskImpl],
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
- Start child run, using idempotency keyed by parent run and node name.
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

## Adapter Responsibilities

Store adapters provide:

- versioned run updates or locks
- node state persistence
- attempt persistence
- child link persistence
- idempotency enforcement
- stale completion rejection

Run coordination executor adapters provide:

- command enqueue
- delayed command enqueue
- continuation command claim/release/ack
- workflow-name filtering where the adapter can support it

Attempt executor adapters provide:

- activity attempt dispatch
- task run attempt dispatch
- attempt claim/release/ack
- worker leasing
- heartbeats or lease expiry, where needed
- concurrency limits

One concrete adapter may implement both executor interfaces. The core runtime
depends on the interfaces, not on BullMQ, Redis, Valkey, Postgres, or cloud queue
SDKs.

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
