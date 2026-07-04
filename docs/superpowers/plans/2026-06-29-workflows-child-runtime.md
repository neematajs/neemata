# Workflows Child Runtime Implementation Plan

> **Superseded task-run note (2026-06-29):** this plan introduced child identity
> while task nodes were still attempt-only. New work should generalize child
> links to task/workflow runs and treat task attempts as internal to task runs.

> **Current status (2026-06-30):** this plan is historical. Direct child
> workflow execution and generalized child run links have landed. Use the
> runtime model spec for current semantics before adding new runtime work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first orchestration runtime slice: structured child identity store support and direct child workflow node execution.

**Architecture:** The store gets graph-agnostic semantic methods for composite child identity. The coordinator uses those methods to start child workflow runs idempotently and resume the parent when the child completes. Activity/task runtime stays unchanged except where shared state types grow identity fields.

**Tech Stack:** TypeScript, Vitest, `@nmtjs/workflows` runtime interfaces, current in-memory test support, `@nmtjs/core` containers, `@nmtjs/type` schemas.

---

## File Structure

- Modify `packages/workflows/src/runtime/state.ts`
  - Add `NodeChildIdentity`.
  - Add `identity` to attempts, child links, and map items.
  - Add branch/member/item fields to child links.
- Modify `packages/workflows/src/runtime/store.ts`
  - Add semantic store params/results.
  - Add `ensureNodeAttempt`, `ensureChildWorkflowRun`, `ensureMapItems`, `completeMapItem`, `failMapItem`, `waitNode`, and `loadNodeChildren`.
- Modify `packages/workflows/tests/support/in-memory-runtime.ts`
  - Implement semantic methods for tests.
  - Keep helper test-only.
- Modify `packages/workflows/src/runtime/coordinator.ts`
  - Add direct child workflow node support.
  - Keep unsupported `branch`, `parallel`, and map nodes throwing for this slice.
- Modify `packages/workflows/tests/runtime-interfaces.spec.ts`
  - Add type/export checks for semantic store contracts.
- Modify `packages/workflows/tests/runtime-store.spec.ts`
  - Add idempotency tests for child identities and semantic store methods.
- Modify `packages/workflows/tests/runtime-coordinator.spec.ts`
  - Add child workflow node runtime tests.

---

### Task 1: Runtime Store Contract For Child Identity

**Files:**

- Modify: `packages/workflows/src/runtime/state.ts`
- Modify: `packages/workflows/src/runtime/store.ts`
- Test: `packages/workflows/tests/runtime-interfaces.spec.ts`

- [ ] **Step 1: Write failing interface/export test**

Add this test case to `packages/workflows/tests/runtime-interfaces.spec.ts`:

```ts
import type {
  EnsureChildWorkflowRunParams,
  EnsureMapItemsParams,
  EnsureNodeAttemptParams,
  NodeChildIdentity,
  NodeChildrenSnapshot,
  StoredChildLink,
  StoredMapItem,
  WaitNodeParams,
  WorkflowStore,
} from '../src/index.ts'

it('exports semantic orchestration store contracts', () => {
  expectTypeOf<NodeChildIdentity>().toMatchTypeOf<{
    runId: string
    nodeName: string
    caseKey?: string
    memberKey?: string
    itemIndex?: number
    itemKey?: string
  }>()

  expectTypeOf<EnsureNodeAttemptParams>().toMatchTypeOf<{
    identity: NodeChildIdentity
    kind: 'activity' | 'task'
    input: unknown
  }>()

  expectTypeOf<EnsureChildWorkflowRunParams>().toMatchTypeOf<{
    identity: NodeChildIdentity
    workflowName: string
    input: unknown
    parentRunId: string
    parentNodeName: string
    rootRunId: string
  }>()

  expectTypeOf<EnsureMapItemsParams>().toMatchTypeOf<{
    runId: string
    nodeName: string
    items: readonly unknown[]
    keys?: readonly string[]
  }>()

  expectTypeOf<NodeChildrenSnapshot>().toMatchTypeOf<{
    attempts: readonly unknown[]
    childLinks: readonly unknown[]
    mapItems: readonly unknown[]
  }>()

  expectTypeOf<WaitNodeParams>().toMatchTypeOf<{
    runId: string
    nodeName: string
  }>()

  expectTypeOf<StoredChildLink>().toHaveProperty('identity')
  expectTypeOf<StoredMapItem>().toHaveProperty('identity')
  expectTypeOf<WorkflowStore>().toHaveProperty('waitNode')
  expectTypeOf<WorkflowStore>().toHaveProperty('ensureChildWorkflowRun')
  expectTypeOf<WorkflowStore>().toHaveProperty('loadNodeChildren')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts --reporter=agent
```

Expected: FAIL with missing exported types such as `NodeChildIdentity` and missing `WorkflowStore.ensureChildWorkflowRun`.

- [ ] **Step 3: Add state types**

Update `packages/workflows/src/runtime/state.ts` with these definitions and fields:

```ts
export type NodeChildIdentity = {
  readonly runId: string
  readonly nodeName: string
  readonly caseKey?: string
  readonly memberKey?: string
  readonly itemIndex?: number
  readonly itemKey?: string
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
  readonly identity?: NodeChildIdentity
  readonly status: RuntimeAttemptStatus
  readonly workerId?: string
  readonly leaseToken?: string
  readonly attemptNumber: number
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly dispatchedAt: Date
  readonly heartbeatAt?: Date
  readonly completedAt?: Date
}

export type StoredChildLink = {
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly childRunId: string
  readonly workflowName: string
  readonly identity: NodeChildIdentity
  readonly caseKey?: string
  readonly memberKey?: string
  readonly itemIndex?: number
  readonly itemKey?: string
}

export type StoredMapItem = {
  readonly runId: string
  readonly nodeName: string
  readonly index: number
  readonly key?: string
  readonly identity: NodeChildIdentity
  readonly item: unknown
  readonly status: RuntimeNodeStatus
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly attemptId?: string
}
```

Keep existing fields not shown here unchanged. Do not remove `StoredAttempt.runId` or `StoredAttempt.nodeName`; existing primitive code uses them.

- [ ] **Step 4: Add store contract types and methods**

Update `packages/workflows/src/runtime/store.ts`:

```ts
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from './state.ts'

export type EnsureNodeAttemptParams = {
  readonly identity: NodeChildIdentity
  readonly kind: 'activity' | 'task'
  readonly input: unknown
}

export type EnsureNodeAttemptResult = {
  readonly attempt: StoredAttempt
  readonly created: boolean
}

export type EnsureChildWorkflowRunParams = {
  readonly identity: NodeChildIdentity
  readonly workflowName: string
  readonly input: unknown
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly rootRunId: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type EnsureChildWorkflowRunResult = {
  readonly childLink: StoredChildLink
  readonly childRun: StoredRun
  readonly created: boolean
}

export type EnsureMapItemsParams = {
  readonly runId: string
  readonly nodeName: string
  readonly items: readonly unknown[]
  readonly keys?: readonly string[]
}

export type EnsureMapItemsResult = {
  readonly items: readonly StoredMapItem[]
  readonly created: boolean
}

export type CompleteMapItemParams = {
  readonly runId: string
  readonly nodeName: string
  readonly itemIndex: number
  readonly itemKey?: string
  readonly output: unknown
}

export type FailMapItemParams = {
  readonly runId: string
  readonly nodeName: string
  readonly itemIndex: number
  readonly itemKey?: string
  readonly error: unknown
}

export type LoadNodeChildrenParams = {
  readonly runId: string
  readonly nodeName: string
}

export type WaitNodeParams = {
  readonly runId: string
  readonly nodeName: string
}

export type NodeChildrenSnapshot = {
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}
```

Add these methods to `WorkflowStore`:

```ts
ensureNodeAttempt(
  params: EnsureNodeAttemptParams,
): Promise<EnsureNodeAttemptResult>
ensureChildWorkflowRun(
  params: EnsureChildWorkflowRunParams,
): Promise<EnsureChildWorkflowRunResult>
ensureMapItems(params: EnsureMapItemsParams): Promise<EnsureMapItemsResult>
completeMapItem(params: CompleteMapItemParams): Promise<StoredMapItem | undefined>
failMapItem(params: FailMapItemParams): Promise<StoredMapItem | undefined>
waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>
loadNodeChildren(params: LoadNodeChildrenParams): Promise<NodeChildrenSnapshot>
```

- [ ] **Step 5: Export runtime contracts**

Make sure `packages/workflows/src/runtime/index.ts` exports the new types by keeping broad exports:

```ts
export type * from './commands.ts'
export type * from './executors.ts'
export type * from './state.ts'
export type * from './status.ts'
export type * from './store.ts'
export { continueWorkflowRun } from './coordinator.ts'
export {
  runActivityAttempt,
  runTaskAttempt,
  runWithConcurrency,
} from './worker.ts'
```

If `runtime/index.ts` already has equivalent exports, leave it unchanged.

- [ ] **Step 6: Run interface test to verify it passes**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts --reporter=agent
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workflows/src/runtime/state.ts packages/workflows/src/runtime/store.ts packages/workflows/src/runtime/index.ts packages/workflows/tests/runtime-interfaces.spec.ts
git commit -m "feat: add workflow orchestration store contracts"
```

---

### Task 2: In-Memory Semantic Store Methods

**Files:**

- Modify: `packages/workflows/tests/support/in-memory-runtime.ts`
- Test: `packages/workflows/tests/runtime-store.spec.ts`

- [ ] **Step 1: Write failing store tests**

Add these tests to `packages/workflows/tests/runtime-store.spec.ts`:

```ts
it('ensures child workflow runs idempotently by structured identity', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const parent = await runtime.store.createRun({
    workflowName: 'parent',
    input: { scenario: 'a' },
  })
  const identity = {
    runId: parent.id,
    nodeName: 'child',
  }

  const first = await runtime.store.ensureChildWorkflowRun({
    identity,
    workflowName: 'child',
    input: { scenario: 'a' },
    parentRunId: parent.id,
    parentNodeName: 'child',
    rootRunId: parent.rootRunId,
  })
  const second = await runtime.store.ensureChildWorkflowRun({
    identity,
    workflowName: 'child',
    input: { scenario: 'a' },
    parentRunId: parent.id,
    parentNodeName: 'child',
    rootRunId: parent.rootRunId,
  })

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.childRun.id).toBe(first.childRun.id)
  expect(second.childLink.childRunId).toBe(first.childRun.id)
  expect(second.childRun.parentRunId).toBe(parent.id)
  expect(second.childRun.rootRunId).toBe(parent.rootRunId)
})

it('ensures node attempts idempotently by structured identity', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: 'parent',
    input: { scenario: 'a' },
  })
  await runtime.store.createNode({
    runId: run.id,
    name: 'fanout',
    kind: 'parallel',
  })
  const identity = {
    runId: run.id,
    nodeName: 'fanout',
    memberKey: 'embedding',
  }

  const first = await runtime.store.ensureNodeAttempt({
    identity,
    kind: 'task',
    input: { text: 'a' },
  })
  const second = await runtime.store.ensureNodeAttempt({
    identity,
    kind: 'task',
    input: { text: 'a' },
  })

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.attempt.id).toBe(first.attempt.id)
  expect(second.attempt.identity).toStrictEqual(identity)
})

it('ensures map items once and rejects conflicting item snapshots', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: 'parent',
    input: { scenario: 'a' },
  })

  const first = await runtime.store.ensureMapItems({
    runId: run.id,
    nodeName: 'cases',
    items: [{ id: 'a' }, { id: 'b' }],
    keys: ['a', 'b'],
  })
  const second = await runtime.store.ensureMapItems({
    runId: run.id,
    nodeName: 'cases',
    items: [{ id: 'a' }, { id: 'b' }],
    keys: ['a', 'b'],
  })

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.items.map((item) => item.key)).toStrictEqual(['a', 'b'])
  await expect(
    runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'cases',
      items: [{ id: 'a' }],
      keys: ['a'],
    }),
  ).rejects.toThrow('Conflicting map items for [')
})

it('loads children for one parent node', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: 'parent',
    input: { scenario: 'a' },
  })
  await runtime.store.createNode({
    runId: run.id,
    name: 'fanout',
    kind: 'parallel',
  })
  await runtime.store.ensureNodeAttempt({
    identity: { runId: run.id, nodeName: 'fanout', memberKey: 'task' },
    kind: 'task',
    input: { text: 'a' },
  })
  await runtime.store.ensureChildWorkflowRun({
    identity: { runId: run.id, nodeName: 'fanout', memberKey: 'child' },
    workflowName: 'child',
    input: { scenario: 'a' },
    parentRunId: run.id,
    parentNodeName: 'fanout',
    rootRunId: run.rootRunId,
  })
  await runtime.store.ensureMapItems({
    runId: run.id,
    nodeName: 'fanout',
    items: ['a'],
  })

  const children = await runtime.store.loadNodeChildren({
    runId: run.id,
    nodeName: 'fanout',
  })

  expect(children.attempts).toHaveLength(1)
  expect(children.childLinks).toHaveLength(1)
  expect(children.mapItems).toHaveLength(1)
})
```

- [ ] **Step 2: Run store tests to verify failure**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-store.spec.ts --reporter=agent
```

Expected: FAIL because semantic store methods are not implemented.

- [ ] **Step 3: Add identity helpers to test runtime**

In `packages/workflows/tests/support/in-memory-runtime.ts`, add helpers near `nodeKey`:

```ts
const identityKey = (identity: NodeChildIdentity) =>
  JSON.stringify({
    runId: identity.runId,
    nodeName: identity.nodeName,
    caseKey: identity.caseKey ?? null,
    memberKey: identity.memberKey ?? null,
    itemIndex: identity.itemIndex ?? null,
    itemKey: identity.itemKey ?? null,
  })

const sameMapItems = (
  existing: readonly StoredMapItem[],
  items: readonly unknown[],
  keys: readonly string[] | undefined,
) =>
  existing.length === items.length &&
  existing.every((item, index) => item.key === keys?.[index])
```

Update imports to include `NodeChildIdentity` from `../../src/runtime/state.ts`.

- [ ] **Step 4: Implement `ensureNodeAttempt`**

Inside the `store` object in `in-memory-runtime.ts`, add:

```ts
async ensureNodeAttempt({ identity, kind, input }) {
  const existing = [...attempts.values()].find(
    (attempt) =>
      attempt.identity &&
      identityKey(attempt.identity) === identityKey(identity),
  )
  if (existing) return { attempt: existing, created: false }

  const key = nodeKey(identity.runId, identity.nodeName)
  const node = nodes.get(key)
  if (!node) {
    throw new Error(`Missing node [${identity.runId}.${identity.nodeName}]`)
  }

  const attempt: StoredAttempt = {
    id: id('attempt'),
    runId: identity.runId,
    nodeName: identity.nodeName,
    identity,
    status: 'started',
    leaseToken: id('attempt-lease'),
    attemptNumber: node.attemptCount + 1,
    input,
    dispatchedAt: now(),
  }
  const updatedNode: StoredNode = {
    ...node,
    status: 'waiting',
    ...(kind === 'activity' || kind === 'task'
      ? { currentAttemptId: attempt.id }
      : {}),
    attemptCount: node.attemptCount + 1,
    version: node.version + 1,
    updatedAt: now(),
  }

  attempts.set(attempt.id, attempt)
  nodes.set(key, updatedNode)
  return { attempt, created: true }
}
```

Do not replace existing `createAttempt` yet.

- [ ] **Step 5: Implement `ensureChildWorkflowRun`**

Inside the `store` object, add:

```ts
async ensureChildWorkflowRun(input) {
  const existingLink = childLinks.find(
    (link) => identityKey(link.identity) === identityKey(input.identity),
  )
  if (existingLink) {
    const childRun = runs.get(existingLink.childRunId)
    if (!childRun) {
      throw new Error(`Missing child run [${existingLink.childRunId}]`)
    }
    return { childLink: existingLink, childRun, created: false }
  }

  const childRun = await store.createRun({
    workflowName: input.workflowName,
    input: input.input,
    parentRunId: input.parentRunId,
    parentNodeName: input.parentNodeName,
    rootRunId: input.rootRunId,
    tags: input.tags,
    idempotencyKey: input.idempotencyKey,
  })
  const childLink: StoredChildLink = {
    parentRunId: input.parentRunId,
    parentNodeName: input.parentNodeName,
    childRunId: childRun.id,
    workflowName: input.workflowName,
    identity: input.identity,
    ...(input.identity.caseKey === undefined
      ? {}
      : { caseKey: input.identity.caseKey }),
    ...(input.identity.memberKey === undefined
      ? {}
      : { memberKey: input.identity.memberKey }),
    ...(input.identity.itemIndex === undefined
      ? {}
      : { itemIndex: input.identity.itemIndex }),
    ...(input.identity.itemKey === undefined
      ? {}
      : { itemKey: input.identity.itemKey }),
  }
  childLinks.push(childLink)
  return { childLink, childRun, created: true }
}
```

- [ ] **Step 6: Implement map item methods**

Inside the `store` object, add:

```ts
async ensureMapItems({ runId, nodeName, items, keys }) {
  const existing = mapItems.filter(
    (item) => item.runId === runId && item.nodeName === nodeName,
  )
  if (existing.length > 0) {
    if (!sameMapItems(existing, items, keys)) {
      throw new Error(`Conflicting map items for [${runId}.${nodeName}]`)
    }
    return { items: existing, created: false }
  }

  const created = items.map((item, index): StoredMapItem => ({
    runId,
    nodeName,
    index,
    ...(keys?.[index] === undefined ? {} : { key: keys[index] }),
    identity: {
      runId,
      nodeName,
      itemIndex: index,
      ...(keys?.[index] === undefined ? {} : { itemKey: keys[index] }),
    },
    item,
    status: 'pending',
  }))
  mapItems.push(...created)
  return { items: created, created: true }
},
async completeMapItem({ runId, nodeName, itemIndex, itemKey, output }) {
  const index = mapItems.findIndex(
    (item) =>
      item.runId === runId &&
      item.nodeName === nodeName &&
      item.index === itemIndex &&
      item.key === itemKey,
  )
  if (index === -1) return undefined
  const item = mapItems[index]!
  if (isTerminalNodeStatus(item.status)) return item

  const updated: StoredMapItem = { ...item, status: 'completed', output }
  mapItems[index] = updated
  return updated
},
async failMapItem({ runId, nodeName, itemIndex, itemKey, error }) {
  const index = mapItems.findIndex(
    (item) =>
      item.runId === runId &&
      item.nodeName === nodeName &&
      item.index === itemIndex &&
      item.key === itemKey,
  )
  if (index === -1) return undefined
  const item = mapItems[index]!
  if (isTerminalNodeStatus(item.status)) return item

  const updated: StoredMapItem = {
    ...item,
    status: 'failed',
    error: storedError(error),
  }
  mapItems[index] = updated
  return updated
}
```

- [ ] **Step 7: Implement `waitNode` and `loadNodeChildren`**

Inside the `store` object, add:

```ts
async waitNode({ runId, nodeName }) {
  const key = nodeKey(runId, nodeName)
  const node = nodes.get(key)
  if (!node) return undefined
  if (isTerminalNodeStatus(node.status)) return node

  const updated: StoredNode = {
    ...node,
    status: 'waiting',
    version: node.version + 1,
    updatedAt: now(),
  }
  nodes.set(key, updated)
  return updated
},
async loadNodeChildren({ runId, nodeName }) {
  return {
    attempts: [...attempts.values()].filter(
      (attempt) => attempt.runId === runId && attempt.nodeName === nodeName,
    ),
    childLinks: childLinks.filter(
      (link) => link.parentRunId === runId && link.parentNodeName === nodeName,
    ),
    mapItems: mapItems.filter(
      (item) => item.runId === runId && item.nodeName === nodeName,
    ),
  }
}
```

- [ ] **Step 8: Run store tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-store.spec.ts --reporter=agent
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/workflows/tests/support/in-memory-runtime.ts packages/workflows/tests/runtime-store.spec.ts
git commit -m "feat: add in-memory orchestration store semantics"
```

---

### Task 3: Child Workflow Runtime Tests

**Files:**

- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add child workflow execution test**

Add this test to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
it('starts a child workflow run and completes the parent from child output', async () => {
  const childWorkflow = defineWorkflow({
    name: 'child-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .activity('write', {
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    .build()
  const parentWorkflow = defineWorkflow({
    name: 'parent-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ caseId: t.string() }),
  })
    .workflow('content', childWorkflow)
    .build()

  const childImplementation = implementWorkflow(childWorkflow)
    .write(async (_ctx, input) => ({ text: input.scenario }))
    .finish((_ctx, { write }) => ({ text: write.text }))
  const parentImplementation = implementWorkflow(parentWorkflow)
    .content(childWorkflow, {
      input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
    })
    .finish((_ctx, { content }) => ({ caseId: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const parentRun = await runtime.store.createRun({
    workflowName: parentWorkflow.name,
    input: { scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command: {
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    },
  })

  const afterStart = await runtime.store.loadRunSnapshot(parentRun.id)
  const childLink = afterStart?.childLinks[0]
  expect(afterStart?.nodes[0]?.status).toBe('waiting')
  expect(childLink?.workflowName).toBe(childWorkflow.name)
  expect(runtime.inspect().continueRunCommands).toStrictEqual([
    {
      id: expect.any(String),
      payload: {
        kind: 'continueRun',
        runId: childLink?.childRunId,
        workflowName: childWorkflow.name,
      },
    },
  ])

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [childImplementation],
    workerId: 'child-coordinator',
    command: {
      kind: 'continueRun',
      runId: childLink!.childRunId,
      workflowName: childWorkflow.name,
    },
  })

  const claimed = await runtime.attemptExecutor.claimActivity({
    workerId: 'activity-worker',
    workflowNames: [childWorkflow.name],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()

  await runActivityAttempt({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [childImplementation],
    workerId: 'activity-worker',
    claimed: claimed!,
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [childImplementation],
    workerId: 'child-coordinator',
    command: {
      kind: 'continueRun',
      runId: childLink!.childRunId,
      workflowName: childWorkflow.name,
    },
  })

  expect(
    runtime
      .inspect()
      .continueRunCommands.some(
        (command) =>
          command.payload.runId === parentRun.id &&
          command.payload.workflowName === parentWorkflow.name,
      ),
  ).toBe(true)

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command: {
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    },
  })

  const finalParent = await runtime.store.loadRunSnapshot(parentRun.id)
  expect(finalParent?.nodes[0]?.status).toBe('completed')
  expect(finalParent?.nodes[0]?.output).toStrictEqual({ text: 'alpha' })
  expect(finalParent?.run.status).toBe('completed')
  expect(finalParent?.run.output).toStrictEqual({ caseId: 'alpha' })
})
```

- [ ] **Step 2: Add duplicate child-start test**

Add:

```ts
it('does not duplicate child workflow runs on repeated parent continuation', async () => {
  const childWorkflow = defineWorkflow({
    name: 'dedup-child',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'dedup-parent',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .workflow('child', childWorkflow)
    .build()
  const parentImplementation = implementWorkflow(parentWorkflow)
    .child(childWorkflow)
    .finish((_ctx, { child }) => ({ text: child.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const parentRun = await runtime.store.createRun({
    workflowName: parentWorkflow.name,
    input: { scenario: 'alpha' },
  })
  const command = {
    kind: 'continueRun' as const,
    runId: parentRun.id,
    workflowName: parentWorkflow.name,
  }

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command,
  })
  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command,
  })

  const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
  expect(snapshot?.childLinks).toHaveLength(1)
  expect(
    runtime
      .inspect()
      .runs.filter((run) => run.workflowName === childWorkflow.name),
  ).toHaveLength(1)
})
```

- [ ] **Step 3: Add child failure propagation test**

Add:

```ts
it('fails the parent node when a child workflow run fails', async () => {
  const childWorkflow = defineWorkflow({
    name: 'failed-child',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'failed-parent',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .workflow('child', childWorkflow)
    .build()
  const parentImplementation = implementWorkflow(parentWorkflow)
    .child(childWorkflow)
    .finish((_ctx, { child }) => ({ text: child.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const parentRun = await runtime.store.createRun({
    workflowName: parentWorkflow.name,
    input: { scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command: {
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    },
  })

  const started = await runtime.store.loadRunSnapshot(parentRun.id)
  const childRunId = started!.childLinks[0]!.childRunId
  await runtime.store.failRun({
    runId: childRunId,
    error: new Error('child failed'),
  })
  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command: {
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    },
  })

  const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
  expect(snapshot?.nodes[0]?.status).toBe('failed')
  expect(snapshot?.run.status).toBe('queued')

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command: {
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    },
  })

  const failedRun = await runtime.store.loadRunSnapshot(parentRun.id)
  expect(failedRun?.run.status).toBe('failed')
})
```

- [ ] **Step 4: Run coordinator tests to verify failure**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: FAIL with `Unsupported runtime node kind [workflow]`.

- [ ] **Step 5: Commit failing tests**

Do not commit failing tests alone. Continue to Task 4.

---

### Task 4: Direct Child Workflow Node Runtime

**Files:**

- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add child workflow imports**

Update imports in `packages/workflows/src/runtime/coordinator.ts`:

```ts
import type {
  ActivityNodeImplementation,
  RunnableNodeImplementation,
  WorkflowImplementation,
  WorkflowNodeImplementation,
} from '../implement/index.ts'
```

`WorkflowNodeImplementation` is already exported from `packages/workflows/src/implement/index.ts`.

- [ ] **Step 2: Route workflow nodes**

In `continueWorkflowRun`, add this before the unsupported node throw:

```ts
if (nextNode.kind === 'workflow') {
  await dispatchWorkflowNode({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: implementation,
    workflowCtx: workflowCtx as DependencyContext<any>,
    run: snapshot.run,
    outputs,
    node: nextNode,
  })
  return
}
```

- [ ] **Step 3: Implement `dispatchWorkflowNode`**

Add below `dispatchTaskNode`:

```ts
async function dispatchWorkflowNode(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: Extract<WorkflowNodeImplementation, { kind: 'workflow' }>
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'workflow',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const existingLink = children.childLinks[0]
  if (existingLink) {
    const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
    const childRun = snapshot?.run
    if (
      !childRun ||
      childRun.status === 'queued' ||
      childRun.status === 'running' ||
      childRun.status === 'waiting'
    ) {
      return
    }
    if (childRun.status === 'completed') {
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.node.name,
        output: childRun.output,
      })
      return
    }
    await input.store.failNode({
      runId: input.run.id,
      nodeName: input.node.name,
      error:
        childRun.error ?? new Error(`Child workflow [${childRun.id}] failed`),
    })
    return
  }

  const nodeInput = input.node.input
    ? input.node.input(input.workflowCtx, input.outputs, input.run.input)
    : input.run.input

  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })

  const child = await input.store.ensureChildWorkflowRun({
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    },
    workflowName: input.node.target.name,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.node.name,
    rootRunId: input.run.rootRunId,
  })

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: child.childRun.id,
    workflowName: input.node.target.name,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
}
```

Update type imports for `StoredRun`:

```ts
import type { StoredRun } from './state.ts'
```

This first version enqueues child continuation only when it creates or reuses a
child link for a non-terminal child. The `ensureChildWorkflowRun` guard handles
duplicates if two coordinators race in the test store.

- [ ] **Step 4: Make child completion enqueue parent continuation**

In the code path where `!nextNode` completes a run, after `completeRun`, enqueue parent continuation when the completed run has parent metadata:

```ts
const completed = await input.store.completeRun({
  runId: snapshot.run.id,
  output,
})
if (completed?.parentRunId && completed.parentNodeName) {
  const parent = await input.store.loadRunSnapshot(completed.parentRunId)
  if (parent) {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: completed.parentRunId,
      workflowName: parent.run.workflowName,
    })
  }
}
```

Keep existing direct run completion behavior unchanged.

- [ ] **Step 5: Run coordinator tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: PASS.

- [ ] **Step 6: Run focused runtime tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts tests/runtime-store.spec.ts tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workflows/src/runtime/coordinator.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: run child workflow nodes"
```

---

### Task 5: Verification And Cleanup

**Files:**

- Review all files changed in Tasks 1-4.

- [ ] **Step 1: Run full workflows tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run --reporter=agent
```

Expected: all workflows tests PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: exit code 0.

- [ ] **Step 3: Run package lint**

Run:

```bash
pnpm oxlint packages/workflows --format=agent
```

Expected: exit code 0. Existing warnings may remain; fix new warnings in touched files.

- [ ] **Step 4: Run dependency boundary scan**

Run:

```bash
rg -n '"bullmq"|"ioredis"|"iovalkey"|"pg"|"postgres"' packages/workflows/package.json packages/workflows/src
```

Expected: exit code 1 and no matches.

- [ ] **Step 5: Review public exports**

Run:

```bash
git diff -- packages/workflows/package.json packages/workflows/src/index.ts packages/workflows/src/runtime/index.ts
```

Expected:

- no new adapter dependency
- no `./testing` export
- new runtime types exported only through existing runtime/root type exports

- [ ] **Step 6: Final commit if cleanup was needed**

If Steps 1-5 required cleanup, commit it:

```bash
git add packages/workflows
git commit -m "fix: polish child workflow runtime"
```

If no cleanup was needed, do not create an empty commit.
