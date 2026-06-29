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
- Preserve room for multiple executors: in-memory, BullMQ, Postgres-backed,
  cloud queues, or Temporal-style adapters.
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

The package owns vocabulary, contracts, implementation builders, runtime
interfaces, public types, and optional adapters. Adapters live behind explicit
subpath exports so importing contracts or runtime interfaces does not evaluate
adapter modules.

Heavy adapter dependencies may live in `packages/workflows/package.json`, but
they should usually be optional peer dependencies. Concrete adapter modules
should fail only when that adapter subpath is imported and its peer dependency is
missing.

## Core Source Scopes

`packages/workflows/src` should use these scopes:

```txt
src/
  index.ts
  contract/
  implement/
  runtime/
  client/
  store/
  executor/
  adapters/
  types/
  internal/
```

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

Pure workflow runtime interfaces and state-machine orchestration.

Owns:

- workflow runner interfaces
- node scheduling semantics
- branch and cancellation application rules
- resume/wakeup protocol
- runtime validation of implementation completeness
- routeability validation for task and child workflow declarations

Rules:

- May depend on `contract`, `implement`, `store`, `executor`, `types`, and
  `internal`.
- Must depend only on interfaces for storage and execution.
- Must not import BullMQ, Redis, Valkey, SQL drivers, or cloud queue SDKs.
- Must support deployments where parent workflows, child workflows, and tasks
  are executed by different worker processes.

### `client`

Public command surface.

Owns:

- `start`
- `get`
- `list`
- `cancel`
- request and response types for public APIs

Rules:

- Should operate against workflow/task contracts, not implementations.
- Should expose Neemata workflow statuses, not adapter-native statuses.
- Must not assume polling, queues, or SQL as the transport model.

### `store`

Persistence interfaces and canonical durable state model.

Owns:

- run-store interface
- idempotency interface
- run, node, activity, task, child workflow, and branch state types
- durable task and workflow run state types
- optimistic/versioned update contracts

Rules:

- Defines source-of-truth concepts.
- Does not implement a database backend.
- Must make duplicate and stale completions representable and ignorable.
- Must distinguish public durable run IDs from internal attempt IDs. Tasks and
  workflows are public run kinds; attempts are retry/lease records.

### `executor`

Dispatch interfaces for tasks and activities.

Owns:

- command enqueue/claim/heartbeat/complete/fail/cancel interfaces
- lease and timeout protocol types
- retry scheduling protocol types
- worker identity types

Rules:

- Defines at-least-once execution semantics.
- Does not implement worker leasing or queue mechanics.
- Must not imply BullMQ queue names or Redis connections.

### `adapters`

Concrete infrastructure bindings behind explicit subpath exports.

Owns:

- BullMQ executor/store integration, if provided
- Postgres run-store integration, if provided
- in-memory testing/runtime adapters, if useful
- adapter-specific option types

Rules:

- Must not be imported by root `index.ts`.
- Must not be imported by `contract`, `implement`, `runtime`, `client`, `store`,
  or `executor`.
- May import optional peer dependencies.
- Must keep adapter-specific concepts out of public core types.

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
  TaskStatus,
  WorkflowActivityNode,
  WorkflowBranchNode,
  WorkflowMapTaskNode,
  WorkflowMapWorkflowNode,
  WorkflowClient,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowRun,
  WorkflowStatus,
  WorkflowTaskNode,
} from './types'
```

Root export must not expose concrete adapters.

Reserved adapter subpath pattern:

```txt
@nmtjs/workflows/adapters/bullmq
@nmtjs/workflows/adapters/postgres
```

Adapter subpaths are the only supported way to import adapter code once concrete
adapters exist. They are not required for the first contract/implementation
draft.
Other subpaths such as `client`, `runtime`, `store`, `executor`, and `testing`
may be added later only when there is a concrete adapter-author or testing use
case.

## Dependency Rules

Dependency direction:

```txt
types/internal <- contract <- implement
types/internal <- store
types/internal <- executor
contract + implement + store + executor -> runtime
contract + types -> client
contract + runtime + store + executor -> adapters/*
```

Core scopes must not import `adapters/*`.

Adapter dependencies in `package.json` should default to optional peers unless a
dependency is small, pure, and needed by the default import graph.

## Runtime Boundary

The core runtime should treat queues as dispatch adapters, not sources of
truth. Canonical state belongs to the store interface:

- run status
- node status
- activity attempts
- child workflow links
- task and child workflow routeability
- output and error state
- idempotency keys

Executor adapters may be at-least-once. Store updates must make duplicate,
late, or stale executor completions safe to ignore.

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

## Current Filesystem Target

The current draft should include only scopes backed by real API code:

```txt
src/
  index.ts
  contract/
  implement/
  types/
```

`runtime`, `client`, `store`, `executor`, `adapters`, and `internal` should be
added only when the first real code in that scope lands. Empty folders are not
useful.

`src/api-draft.demo.ts` is acceptable while iterating on API feel, but it should
move to `tests`, `examples`, or be removed before treating the package as a
publishable API surface.

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
- Runtime code can execute through interfaces without importing the concrete
  executor or store backend.
- Adapter subpaths can be added or removed without changing public workflow
  contracts.
