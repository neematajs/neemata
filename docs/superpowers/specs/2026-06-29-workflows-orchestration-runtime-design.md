# Workflows Orchestration Runtime Design

## Context

The first runtime slice executes linear `activity` and `task` nodes. The public
API already declares richer graph nodes:

- child `workflow`
- `branch`
- `parallel`
- `mapTask`
- `mapWorkflow`

These nodes need one runtime model before implementation continues. Planning
them one-by-one risks inconsistent state shapes, worker routing, output
semantics, and retry/cancellation behavior.

This spec designs all v1 orchestration nodes together. Implementation can still
land in smaller slices.

## Goals

- Make every public v1 node executable by the runtime model.
- Keep queues as dispatch details and store state as source of truth.
- Support child workflow runs on different workers than the parent workflow.
- Keep orchestration nodes bounded: they compose primitive runnable specs, not
  arbitrary nested subgraphs.
- Make duplicate continuations, stale attempts, and repeated child starts safe.
- Preserve declaration/implementation split: contracts describe structure;
  implementations provide mappers, selectors, handlers, and runtime policies.
- Keep failure semantics simple for v1 while leaving room for richer policies.

## Non-Goals

- Do not implement these nodes in this spec.
- Do not add arbitrary nested branch/parallel/map subgraphs in v1.
- Do not add retries, backoff scheduling, cancellation propagation, progress
  events, signals, queries, or watch APIs in this spec.
- Do not define final SQL tables or adapter-specific queues.
- Do not make the in-memory test runtime public.

## Runtime Node Classes

V1 runtime has two classes of graph nodes.

Primitive runnable nodes:

- `activity`: workflow-local handler attempt
- `task`: reusable child task run, with internal attempts
- `workflow`: child workflow run, start-and-wait in v1

Bounded orchestration nodes:

- `branch`: select one primitive runnable case
- `parallel`: run fixed primitive runnable members
- `mapTask`: run one child task run per item
- `mapWorkflow`: run one child workflow per item

Orchestration nodes do not contain arbitrary subgraphs. They own a bounded set
of primitive runnable children or map items.

## Shared State Model

The existing persisted entities remain the base:

- `run`
- `node`
- `attempt`
- `childLink`
- `mapItem`

V1 orchestration should use one top-level `node` record for every declared graph
node. Composite node internals are represented by attempts, child links, or map
items attached to that node.

### Parent Node State

Every orchestration node uses the parent `node` record as the durable summary:

- `status`: `pending`, `running`, `waiting`, `failed`, `completed`, etc.
- `input`: frozen node input or item snapshot source, when applicable
- `output`: completed node output
- `error`: failed node error
- `selectedCase`: branch case key
- `attemptCount`: not used for child workflow nodes directly, but may count
  dispatch rounds later
- `version`: optimistic update guard

Rules:

- `pending` means the coordinator has not made the node decision yet.
- `running` means the coordinator is computing or dispatching internal work.
- `waiting` means external work is in progress: attempts, child runs, or map
  items.
- `completed`, `failed`, and `cancelled` are terminal no-op states.
- Parent node output is written once after all internal work converges.

### Child Links

`childLink` represents a durable parent-to-child runnable relation. The child
can be a task run or workflow run.

Fields:

- parent run ID
- parent node name
- child run ID
- child run kind: `task` or `workflow`
- child runnable name
- optional branch case key
- optional parallel member key
- optional map item index
- optional map item key

Rules:

- Parent persists child link before dispatching child continuation.
- Duplicate child starts reuse existing child link.
- Parent does not infer child identity from queue state.
- Child completion enqueues parent `continueRun`.

### Map Items

`mapItem` represents one item inside `mapTask` or `mapWorkflow`.

Fields:

- run ID
- node name
- item index
- optional stable item key
- original item snapshot
- status
- output
- error
- child task run ID for `mapTask`
- child workflow run ID for `mapWorkflow`

Rules:

- Item list is computed once and persisted before dispatch.
- Repeated continuations use persisted item snapshots.
- Item outputs are collected by item index.
- Duplicate item completions are no-ops once item is terminal.

## Continuation Model

The coordinator remains the only code path that advances parent runs.

Every external completion enqueues:

```ts
{
  kind: 'continueRun',
  runId,
  workflowName,
}
```

Triggers:

- activity attempt completion
- task attempt completion
- child workflow completion
- map item completion
- future retry delay expiry
- future cancellation signal

Continuation logic:

1. Acquire run lease.
2. Load run snapshot.
3. Validate command workflow name matches stored run workflow name.
4. Exit if run is terminal.
5. Locate first incomplete declared node.
6. Advance that node based on kind and current persisted state.
7. Release lease.

Duplicate continuations are expected and must be harmless.

## Primitive Node Semantics

### Activity Node

Current behavior remains:

- create node
- compute node input through implementation mapper
- persist node input
- create attempt
- dispatch activity attempt
- wait
- worker completes attempt
- worker completes node and enqueues continuation

Activity workers need workflow implementation because activity handlers are
workflow-local.

### Task Node

Task node external work is a child task run.

- create node
- compute node input through implementation mapper
- persist node input
- create/reuse child task run and child link for `(parentRunId, nodeName)`
- dispatch task run attempt
- wait
- task worker completes task run
- task run terminal state enqueues parent continuation
- parent completes node from child task output

Task workers need only task implementations. They do not need parent workflow
implementations.

### Workflow Node

Child workflow node is a primitive runnable node whose external work is a child
run.

Coordinator behavior:

1. Create parent node.
2. Compute child workflow input through implementation mapper.
3. Persist parent node input.
4. Look for existing child link for `(parentRunId, nodeName)`.
5. If missing, create child run with parent/root metadata.
6. Persist child link.
7. Enqueue child `continueRun`.
8. Mark parent node `waiting`.
9. On continuation, load child run through child link.
10. If child completed, complete parent node with child output.
11. If child failed/cancelled, fail parent node in v1.
12. If child still active, remain waiting.

Rules:

- V1 child workflow mode is `start-and-wait`.
- Contract should reserve `mode`, but runtime only accepts start-and-wait.
- Child worker routing is by child workflow name.
- Parent workflow worker does not need child workflow implementation to wait on
  an existing child link.
- Starting child and persisting child link must be atomic from runtime
  perspective. Store interface can model this as one semantic operation later.

## Branch Node Semantics

Branch chooses one primitive runnable case.

Coordinator behavior:

1. Create parent branch node.
2. If `selectedCase` missing, evaluate implementation `select`.
3. Persist selected case on parent node.
4. Resolve selected case implementation.
5. Dispatch selected case based on primitive kind:
   - activity: create attempt tied to branch node and case key
   - task: create/reuse child task run link tied to branch node and case key
   - workflow: create/reuse child workflow run link tied to branch node and case
     key
6. Mark parent branch node `waiting`.
7. On continuation, inspect selected child attempt/run-link state.
8. Complete branch node with selected case output.

Output typing:

- If branch declaration provides `output`, runtime validates conceptually that
  every case converges to that shape.
- If branch declaration omits `output`, TypeScript can infer a discriminated
  union from case outputs. Runtime stores the selected case key and raw selected
  output.
- Public node output is the selected case output, not a wrapper object.
- Store state keeps `selectedCase` separately from `output`, so runtime and UI
  can inspect which case ran without forcing downstream workflow mappers to
  unwrap branch results.

Rules:

- `select` is evaluated once.
- Unknown selected case fails the branch node.
- Selected case is persisted before dispatch.
- Duplicate continuations reuse selected case.
- Non-selected cases do not exist at runtime.

## Parallel Node Semantics

Parallel runs a fixed set of primitive runnable members.

Coordinator behavior:

1. Create parent parallel node.
2. For each declared member, create or reuse member state.
3. Dispatch members that are not terminal:
   - activity attempts
   - child task/workflow runs
4. Mark parent node `waiting`.
5. On continuation, inspect all member states.
6. If all completed, complete parent node with object keyed by member name.
7. If any failed/cancelled, fail parent node in v1.
8. Otherwise remain waiting.

Member state representation:

- For activity members, use attempt records with metadata that identifies parent
  node and member key.
- For task/workflow members, use child links with member key.

Rules:

- Parallel dispatch must be idempotent per member key.
- Member inputs are computed once and persisted.
- Output order is object/member-key based, not completion-order based.
- V1 failure policy is fail-fast at parent convergence time, not necessarily
  cancellation of still-running members.

Future-compatible policy:

```ts
failure: 'fail-fast' | 'wait-all' | 'settled'
```

V1 implements only `fail-fast` semantics for parent result.

## MapTask Node Semantics

`mapTask` runs one child task run per item.

Coordinator behavior:

1. Create parent map node.
2. If no map items exist, evaluate `items(ctx, outputs, workflowInput)`.
3. Persist item snapshots with index and optional key.
4. For each item, create/reuse child task run and child link.
5. Mark parent node `waiting`.
6. On continuation, inspect child task runs through links.
7. If all completed, complete parent node based on mode.
8. If failures exist, apply mode/failure policy.

V1 modes:

- `wait-all`: all items must complete; any failed item fails parent.
- `wait-settled`: parent completes with per-item settled results.
- `start-only`: parent completes after child task run links are persisted,
  without waiting for completion.

Recommended v1 implementation order:

1. `wait-all`
2. `wait-settled`
3. `start-only`

Rules:

- Item array is evaluated once.
- Item input mapper receives `(ctx, outputs, item, workflowInput, index)`.
- Child task run stores parent run ID, parent node name, root run ID, and item
  index.
- Task worker does not need parent workflow implementation.
- Map output includes child task run IDs.
- Map output preserves item order by index.

Failure policy:

- `wait-all`: any failed item fails parent.
- `wait-settled`: failed items become settled error entries; parent can
  complete.
- `start-only`: child run creation/dispatch failures fail parent; later item
  failures do not affect parent because parent already completed.

## MapWorkflow Node Semantics

`mapWorkflow` runs one child workflow per item.

Coordinator behavior:

1. Create parent map node.
2. If no map items exist, evaluate and persist item snapshots.
3. For each item, create/reuse child run and child link.
4. Mark item and parent node based on mode.
5. Enqueue child continuations.
6. On parent continuation, inspect child runs through links.
7. Complete parent based on mode and child statuses.

V1 modes:

- `wait-all`
- `wait-settled`
- `start-only`

Rules:

- Child workflow routing is by child workflow name.
- Parent workflow worker does not need child implementation.
- Child run stores parent run ID, parent node name, root run ID, and item index.
- Duplicate continuation must not create duplicate child runs.
- Map output preserves item order by index.

Failure policy mirrors `mapTask`.

## Attempt And Child Identity

The runtime needs stable internal identities for composite children.

Suggested internal identity fields:

```ts
type NodeChildIdentity = {
  runId: string
  nodeName: string
  caseKey?: string
  memberKey?: string
  itemIndex?: number
  itemKey?: string
}
```

Attempt records and child links should carry enough identity to let coordinator
find the right child state without parsing string names.

Avoid dot-path public names such as `caseContent.normal`. Dot paths may be used
internally only if backed by structured identity fields.

## Worker Routing

Coordinator workers:

- claim `continueRun` by workflow name
- need implementation for claimed workflow
- can wait on child workflows without child implementation

Activity workers:

- claim activity attempts by parent workflow name and optional activity name
- need parent workflow implementation
- release unsupported commands without mutating durable state

Task workers:

- claim task attempts by task name
- need task implementation only
- release unsupported commands without mutating durable state

Child workflow execution:

- parent coordinator creates child run and enqueues child continuation
- separate coordinator worker for child workflow can claim it
- child completion enqueues parent continuation

## Store Interface Implications

The current store interface is enough for primitive activity/task tests but too
thin for full orchestration.

The store should expose semantic, atomic operations where the coordinator needs
idempotency. It should not expose only low-level CRUD calls and force the
coordinator to hand-roll "check then create" races.

The store should also stay graph-agnostic. It should not know whether a child
identity came from `branch`, `parallel`, `mapTask`, or `mapWorkflow`. The
coordinator owns graph semantics. The store owns identity uniqueness and state
transitions.

### Child Identity

Composite children share one structured identity:

```ts
type NodeChildIdentity = {
  runId: string
  nodeName: string
  caseKey?: string
  memberKey?: string
  itemIndex?: number
  itemKey?: string
}
```

Uniqueness rules:

- primitive node attempt: `{ runId, nodeName }`
- branch case attempt/link: `{ runId, nodeName, caseKey }`
- parallel member attempt/link: `{ runId, nodeName, memberKey }`
- map item attempt/link: `{ runId, nodeName, itemIndex, itemKey? }`

The identity fields must be stored structurally. Dot-path strings are not enough.

### Semantic Store Methods

Store additions:

```ts
type EnsureNodeAttemptParams = {
  identity: NodeChildIdentity
  kind: 'activity' | 'task'
  input: unknown
}

type EnsureNodeAttemptResult = {
  attempt: StoredAttempt
  created: boolean
}

type EnsureChildRunParams = {
  identity: NodeChildIdentity
  childKind: 'task' | 'workflow'
  childName: string
  input: unknown
  parentRunId: string
  parentNodeName: string
  rootRunId: string
  tags?: Readonly<Record<string, string>>
  idempotencyKey?: readonly unknown[]
}

type EnsureChildRunResult = {
  childLink: StoredChildLink
  childRun: StoredRun
  created: boolean
}

type EnsureMapItemsParams = {
  runId: string
  nodeName: string
  items: readonly unknown[]
  keys?: readonly string[]
}

type EnsureMapItemsResult = {
  items: readonly StoredMapItem[]
  created: boolean
}

type CompleteMapItemParams = {
  runId: string
  nodeName: string
  itemIndex: number
  itemKey?: string
  output: unknown
}

type FailMapItemParams = {
  runId: string
  nodeName: string
  itemIndex: number
  itemKey?: string
  error: unknown
}

type LoadNodeChildrenParams = {
  runId: string
  nodeName: string
}

type WaitNodeParams = {
  runId: string
  nodeName: string
}

type NodeChildrenSnapshot = {
  attempts: readonly StoredAttempt[]
  childLinks: readonly StoredChildLink[]
  mapItems: readonly StoredMapItem[]
}

interface WorkflowStore {
  ensureNodeAttempt(
    params: EnsureNodeAttemptParams,
  ): Promise<EnsureNodeAttemptResult>

  ensureChildRun(params: EnsureChildRunParams): Promise<EnsureChildRunResult>

  ensureMapItems(
    params: EnsureMapItemsParams,
  ): Promise<EnsureMapItemsResult>

  completeMapItem(
    params: CompleteMapItemParams,
  ): Promise<StoredMapItem | undefined>

  failMapItem(
    params: FailMapItemParams,
  ): Promise<StoredMapItem | undefined>

  waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>

  loadNodeChildren(
    params: LoadNodeChildrenParams,
  ): Promise<NodeChildrenSnapshot>
}
```

### Method Semantics

`ensureNodeAttempt`:

- Creates one current attempt for the structured identity if missing.
- Returns existing non-terminal or terminal attempt for the same identity.
- Does not create duplicate attempts for duplicate continuations.
- Does not decide whether the identity is branch, parallel, or map.

`ensureChildRun`:

- Atomically creates or returns child task/workflow run plus child link for the
  identity.
- Persists child link before child execution is dispatched.
- Returns `created: false` for duplicate continuations.
- Does not require parent coordinator to have child task/workflow
  implementation.

`ensureMapItems`:

- Persists item snapshots once for `(runId, nodeName)`.
- Returns existing snapshots on duplicate continuation.
- If repeated with different item count or different keys, rejects with a store
  conflict error. The coordinator should fail the parent node rather than
  silently replacing item snapshots.

`completeMapItem` and `failMapItem`:

- Update only non-terminal map items.
- Return terminal existing item as no-op when already completed/failed/cancelled.
- Ignore stale completion if item identity does not match.

`loadNodeChildren`:

- Loads all structured child state for one parent node.
- Coordinator uses this to converge branch, parallel, and map nodes.

`waitNode`:

- Marks a non-terminal node as `waiting`.
- Returns terminal existing node as no-op when already completed/failed/cancelled.
- Coordinator calls this after dispatching child attempts or child runs for
  workflow, branch, parallel, and map nodes.

### Compatibility With Existing Methods

Existing primitive methods can remain for the first runtime slice:

- `createNode`
- `setNodeInput`
- `createAttempt`
- `completeCurrentAttempt`
- `failCurrentAttempt`
- `completeNode`
- `failNode`

When orchestration lands, direct primitive nodes may keep using current methods
or migrate to `ensureNodeAttempt({ identity: { runId, nodeName }, ... })`.
Composite nodes should use the semantic methods from day one.

## Failure Semantics For V1

Default v1 behavior:

- activity failure fails node, then run
- task failure fails node, then run
- child workflow failure fails parent workflow node, then run
- branch selected case failure fails branch node, then run
- parallel member failure fails parallel node, then run
- `mapTask`/`mapWorkflow` failure depends on mode

No automatic cancellation of sibling work in v1. That needs explicit
cancellation model later.

## Implementation Slices

Implement in this order:

1. **Store child identity support**
   Add structured child identity for attempts, child links, and map items in
   runtime state and test store.

2. **Child workflow node**
   Implement direct `.workflow(...)` start-and-wait first. This proves child
   links and separate worker routing.

3. **Branch node**
   Implement branch over primitive activity/task/workflow cases. Persist
   selected case before dispatch.

4. **Parallel node**
   Implement fixed primitive members. Complete with member-keyed output.

5. **MapTask node**
   Implement item snapshotting and `wait-all`; add `wait-settled` after core
   behavior is stable.

6. **MapWorkflow node**
   Reuse child workflow and map item machinery.

7. **Start-only modes**
   Add `start-only` after wait modes are stable, because it changes completion
   timing.

## Acceptance Criteria

- Runtime can execute every public v1 graph node kind without throwing
  unsupported node errors.
- Parent and child workflow workers can be separate.
- Duplicate continuation commands do not duplicate attempts, child runs, or map
  items.
- Branch selection is persisted and evaluated once.
- Parallel output is keyed by declared member name.
- Map output preserves input item order.
- Unsupported attempt commands release without mutating durable state.
- No BullMQ, Redis, Valkey, Postgres, or cloud queue dependencies are added to
  `@nmtjs/workflows`.
