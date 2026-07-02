# Workflows Package Scopes Design

## Context

`@nmtjs/jobs` currently mixes several concerns behind one API surface:

- public job declaration
- worker implementation
- multi-step orchestration
- queue/runtime management
- BullMQ-backed persistence and status behavior

That coupling makes declaration imports heavier than they should be and makes the
public model inherit queue-runtime details. The new `@nmtjs/workflows` package is
the place to design the replacement boundary before implementation pressure
locks in the wrong shape.

## Goals

- Keep workflow and task declarations safe to import from API, client, router,
  scheduler, and UI-facing code.
- Keep worker implementations separate from declarations.
- Keep infrastructure adapters out of the default import graph.
- Keep declaration graph metadata inspectable from contracts alone.
- Make workflow state first-class, not a BullMQ progress/status wrapper.
- Make Postgres the first durable runtime substrate: state and internal queue
  commands should share one database transaction.
- Avoid a vague `shared` scope that becomes an ownership dump.

## Non-Goals

- Do not implement workflow runtime behavior in this spec.
- Do not choose the final run-store schema in this spec.
- Do not expose signals, queries, timers, watch/subscribe, or reusable
  `defineActivity` in the v1 public API.
- Do not migrate `@nmtjs/jobs` yet.
- Do not make BullMQ, SQL, Redis, or Valkey required for importing
  `@nmtjs/workflows`.

## Package Layout

Use one package with dependency-light default exports:

```txt
packages/workflows
```

The package owns vocabulary, contracts, implementation builders, runtime code,
public types, and Postgres runtime integration. Postgres code lives behind
explicit subpath exports so importing contracts does not evaluate database or
migration-tool modules.

Heavy Postgres-adjacent dependencies may live in `packages/workflows/package.json`,
but they should usually be optional peer dependencies. Concrete Postgres modules
should fail only when that subpath is imported and its peer dependency is
missing.

## Core Source Scopes

`packages/workflows/src` currently uses these scopes:

```txt
src/
  index.ts
  contract/
  implement/
  runtime/
  adapters/
  types/
```

`client` and `internal` should be added only when backed by real code. Store and
executor contracts currently live under `runtime/` because the runtime is the
only consumer. They are internal/transitional seams, not a promise that workflow
runtime backends are interchangeable.

### `contract`

Declaration-only user API.

Owns:

- `defineTask`
- `defineWorkflow`
- contract object brands and guards
- input, output, node graph, branch, parallel, map fan-out, child workflow,
  and cancellation declaration shapes

Rules:

- Must be safe to import anywhere.
- Must not import implementation builders.
- Must not import runtime, store, executor, or adapter code.
- Must not import app services, DB clients, queue clients, or worker-only code.
- Must preserve enough typed node metadata for declaration-only graph
  introspection.

### `implement`

Worker/runtime implementation API.

Owns:

- `implementTask`
- `implementWorkflow`
- activity handler definitions
- workflow builder definitions
- implementation-time validation
- task and child workflow declaration acknowledgement in implementation order
- branch and parallel leaf-case implementation binding
- map task/workflow declaration acknowledgement in implementation order
- dependency binding shapes for handlers

Rules:

- May depend on `contract`, `types`, and `internal`.
- May describe side-effect boundaries, but must not perform dispatch itself.
- Must not import concrete adapters.
- Must not require parent workflow implementations to import child workflow or
  task implementations.
- Must make external runnable nodes visible in the implementation chain by
  requiring the matching task/workflow declaration.
- Must keep orchestration bounded: branch and parallel bind primitive leaves,
  not arbitrary nested subgraphs.

### `runtime`

Workflow runtime state-machine orchestration.

Owns:

- workflow runner interfaces
- node scheduling semantics
- branch and cancellation application rules
- resume/wakeup protocol
- runtime validation of implementation completeness
- routeability validation for task and child workflow declarations

Rules:

- May depend on `contract`, `implement`, `types`, and internal runtime seams.
- Must keep root imports database-light.
- May keep store/executor interfaces internally while the runtime is being
  refactored, but those interfaces should not become app-facing backend
  extension points.
- Must not import BullMQ, Redis, Valkey, or cloud queue SDKs.
- Must support deployments where parent workflows, child workflows, and tasks
  are executed by different worker processes.

### `client`

Reserved public command surface. This scope does not exist yet.

Owns:

- `start`
- `get`
- `list`
- `cancel`
- request and response types for public APIs

Rules:

- Should operate against workflow/task contracts, not implementations.
- Should expose Neemata workflow statuses, not adapter-native statuses.
- May assume the v1 durable runtime is Postgres-backed, while keeping the public
  client vocabulary workflow-specific.

### `store`

Internal persistence contracts and canonical durable state model. These
currently live inside `runtime/store.ts`.

Owns:

- run-store interface
- idempotency interface
- run discovery/list interface
- run, node, activity, task, child workflow, and branch state types
- durable task and workflow run state types
- optimistic/versioned update contracts

Rules:

- Defines source-of-truth concepts.
- Should map directly to Postgres-backed runtime behavior.
- Must make duplicate and stale completions representable and ignorable.
- Must make run idempotency, child links, map items, and snapshots atomic enough
  to implement with database constraints and transactions.
- Must distinguish public durable run IDs from internal attempt IDs. Tasks and
  workflows are public run kinds; attempts are retry/lease records.

### `executor`

Internal dispatch contracts for run coordination and attempts. These currently
live inside `runtime/executors.ts`.

Owns:

- command enqueue/claim/heartbeat/ack/release interfaces
- lease and timeout protocol types
- worker identity types

Rules:

- Defines at-least-once execution semantics.
- Should be backed by Postgres command tables in the v1 durable runtime.
- Must not imply BullMQ queue names or Redis connections.
- Cancel propagation and retry scheduling are future runtime concepts, not
  current executor interfaces.

### `postgres`

Postgres runtime substrate behind explicit subpath exports.

Owns:

- Postgres runtime construction
- Postgres command-table queue implementation
- Postgres schema verification
- Drizzle schema artifact factory
- testing/local schema bootstrap helpers

Rules:

- Must not be imported by root `index.ts`.
- Must not be imported by `contract`, `implement`, `runtime`, `client`, `store`,
  or `executor`.
- May import optional peer dependencies.
- Must keep Postgres-specific concepts out of root public workflow types.
- Should be exported as `@nmtjs/workflows/postgres` and
  `@nmtjs/workflows/postgres/drizzle`.

### `types`

Public type helpers.

Owns:

- status unions
- run/result/input/output inference helpers
- public graph types: `WorkflowNode`, `WorkflowActivityNode`,
  `WorkflowTaskNode`, `WorkflowChildWorkflowNode`, `WorkflowBranchNode`,
  `WorkflowParallelNode`, `WorkflowMapTaskNode`, `WorkflowMapWorkflowNode`, and
  `BranchCaseDefinition`
- branch type helpers
- branded public helper types

Rules:

- Prefer type-only exports.
- Runtime values belong in domain scopes unless they are small public constants.

### `internal`

Private package helpers.

Owns:

- symbols
- assertions
- normalization helpers
- private errors
- internal object freezing/branding utilities

Rules:

- Not exported from root.
- Free to break between versions.
- Must not become a `shared` replacement for public concepts.

## Public Export Policy

Root `src/index.ts` exports only stable, dependency-light API:

```ts
export { defineTask, defineWorkflow } from './contract'
export { implementTask, implementWorkflow } from './implement'
export type {
  TaskImplementation,
  TaskStatus,
  WorkflowImplementation,
  WorkflowActivityNode,
  WorkflowBranchNode,
  WorkflowMapTaskNode,
  WorkflowMapWorkflowNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowRun,
  WorkflowStatus,
  WorkflowTaskNode,
} from './types'
```

Root export should not expose runtime helpers, store/executor interfaces,
Postgres modules, or implementation-builder internals such as chain, mapper,
idempotency callback, or inline activity helper types.

`createWorkflowRuntimeClient` is a server-side runtime convenience wrapper over
the store and executor interfaces. It lives under `@nmtjs/workflows/runtime`,
not the root package, and is not the final app-facing client scope.
`createInMemoryWorkflowRuntime` may remain under the runtime subpath as a narrow
test/local helper during the pivot, but it is not a second durable runtime
target.

Current subpaths:

```txt
@nmtjs/workflows/runtime
@nmtjs/workflows/postgres
@nmtjs/workflows/postgres/drizzle
```

BullMQ/cloud queue subpaths are out of scope for v1.
Other subpaths such as `client` and `testing` may be added later only when there
is a concrete use case.

## Dependency Rules

Dependency direction:

```txt
types/internal <- contract <- implement
types/internal <- store
types/internal <- executor
contract + implement + store + executor -> runtime
contract + types -> client
contract + runtime + store + executor -> postgres
```

Core scopes must not import `adapters/*`.

Adapter dependencies in `package.json` should default to optional peers unless a
dependency is small, pure, and needed by the default import graph.

## Runtime Boundary

The durable runtime should treat the Postgres database as the state and command
substrate. Canonical state belongs to workflow tables:

- run status
- node status
- activity attempts
- child workflow links
- task and child workflow routeability
- output and error state
- idempotency keys

Internal command queues may be at-least-once. Store updates must make duplicate,
late, or stale command completions safe to ignore. State updates and follow-up
command inserts should happen in one transaction whenever they must be atomic.

## Workflow Vocabulary

Use these top-level user concepts:

- `task`: one isolated background unit
- `workflow`: durable coordinator of primitive leaves and bounded orchestration
  nodes
- `activity`: side-effecting operation invoked by a workflow

Primitive leaves:

- `activity`
- `task`
- `workflow`

Bounded orchestration nodes:

- `branch`: choose one primitive leaf
- `parallel`: run named primitive leaves concurrently
- `mapTask`: run one task per runtime item
- `mapWorkflow`: run one child workflow per runtime item

Do not stretch `job` to mean all of these.

Reserved future concepts:

- reusable `defineActivity`
- signals
- queries
- timers
- timeline events and progress subscriptions
- watch/subscribe client APIs
- workflow-level retry

## Current Filesystem

The current package should include only scopes backed by real API code:

```txt
src/
  index.ts
  contract/
  implement/
  runtime/
  adapters/
  types/
```

`runtime/client.ts`, `runtime/in-memory.ts`, and `adapters/postgres*` exist
today. `runtime/in-memory.ts` is a test/local helper, not a parallel production
backend. A top-level `client` scope and `internal` should be added only when the
first real code in those scopes lands. Empty folders are not useful.

API feel playgrounds live under `tests/examples`. They are type-checked with
the package but are not part of the publishable `src` surface or build output.

## Design Guardrails

- If importing a module can pull infrastructure dependencies, that module cannot
  be reachable from the root `@nmtjs/workflows` export.
- If a concept is part of user vocabulary, it should not live in `internal`.
- If a helper is used by more than one scope but has no domain name, reconsider
  the boundary before creating a shared helper.
- If an adapter detail appears in a public type name, the boundary leaked.
- If a workflow declaration requires importing its implementation, the contract
  split failed.
- If workflow graph introspection requires importing worker code, the contract
  split failed.
- If runtime node objects and public node types describe different shapes, the
  declaration model is dishonest.
- If a parent workflow implementation must import a child workflow/task
  implementation, distributed execution leaked into user code.

## Acceptance Criteria

- `@nmtjs/workflows` root can be imported without BullMQ, Redis, Valkey, SQL, or
  cloud queue packages installed.
- Workflow and task declarations can be imported by API/client/router code
  without worker handlers.
- Workflow declarations expose a typed graph with activity, task, child
  workflow, and branch metadata without importing implementations.
- Worker implementations can import app dependencies without polluting contract
  imports.
- Parent workflow implementations show task and child workflow nodes by assigning
  declarations, while child/task implementations can live in separate workers.
- Branch and parallel cases are limited to primitive leaves in v1; complex case
  logic should be modeled as child workflows.
- Runtime code can execute without root imports pulling Postgres modules.
- Postgres subpaths can evolve without changing public workflow contracts.
