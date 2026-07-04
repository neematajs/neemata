# Workflows Branch Runtime Implementation Plan

> **Superseded task-run note (2026-06-29):** this completed slice dispatches
> task branch cases as task attempts. The target model changed: task cases should
> create/reuse child task runs, and attempts should remain internal to those
> runs.

> **Current status (2026-06-30):** this plan is historical. Branch, parallel,
> mapped task, and mapped workflow runtime support now use structured child
> identities and durable task/workflow child runs. Use the runtime model spec for
> current semantics before adding new runtime work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add v1 runtime execution for `branch` workflow nodes over primitive `activity`, `task`, and child `workflow` cases.

**Architecture:** Branch nodes are orchestration nodes, not nested graphs. The coordinator selects one case once, persists that selected case on the parent node, dispatches only the selected primitive child with a structured `{ runId, nodeName, caseKey }` identity, and completes the branch node with the selected case output. Existing child workflow and attempt recovery rules must apply to branch cases too.

**Tech Stack:** TypeScript, Vitest, `@nmtjs/workflows` runtime interfaces, in-memory runtime test support, `@nmtjs/core` containers, `@nmtjs/type` schemas.

---

## File Structure

- Modify `packages/workflows/src/runtime/state.ts`
  - `StoredNode.selectedCase` already exists. Keep it as the durable branch case marker.
- Modify `packages/workflows/src/runtime/store.ts`
  - Add a semantic `selectNodeCase` method that persists branch selection idempotently.
- Modify `packages/workflows/tests/support/in-memory-runtime.ts`
  - Implement `selectNodeCase`.
  - Keep method generic enough for later branch/parallel runtime tests, but only branch uses it now.
- Modify `packages/workflows/tests/runtime-interfaces.spec.ts`
  - Assert selected-case store contracts are exported and required.
- Modify `packages/workflows/tests/runtime-store.spec.ts`
  - Test idempotent selected-case persistence and conflicting selection rejection.
- Modify `packages/workflows/src/runtime/coordinator.ts`
  - Add branch runtime dispatch and convergence.
  - Factor existing activity/task/child workflow dispatch just enough to support `caseKey` identities without duplicating logic.
  - Keep `parallel`, `mapTask`, and `mapWorkflow` unsupported.
- Modify `packages/workflows/src/runtime/worker.ts`
  - Resolve branch inline activity handlers from the selected branch case when processing activity attempt commands for a branch node.
  - Task attempts already use global task implementation lookup and do not need workflow-node lookup.
- Modify `packages/workflows/tests/runtime-coordinator.spec.ts`
  - Add branch runtime tests.
- Modify `packages/workflows/tests/runtime-worker.spec.ts`
  - Add branch inline activity worker lookup test if coordinator tests do not already exercise the worker path clearly.

---

## Runtime Semantics

Branch coordinator behavior:

1. Create parent node with kind `branch`.
2. If `selectedCase` is missing, evaluate implementation `select(ctx, outputs, workflowInput)` once.
3. Persist selected case using `store.selectNodeCase`.
4. If selected case is unknown, fail branch node and parent run.
5. Dispatch selected case:
   - activity: create/reuse attempt with identity `{ runId, nodeName, caseKey }`
   - task: create/reuse attempt with identity `{ runId, nodeName, caseKey }`
   - workflow: create/reuse child link with identity `{ runId, nodeName, caseKey }`
6. Mark branch node waiting while selected case is active.
7. On continuation, inspect only selected case attempt/link.
8. Complete branch node with selected case output, not a wrapper object.
9. Continue parent workflow from the branch output.

Rules:

- `select` is evaluated once.
- Duplicate continuation reuses persisted `selectedCase`.
- Non-selected cases are not dispatched.
- Unknown selected case fails branch node and run.
- Lost enqueue recovery mirrors direct child workflow behavior.
- Branch activity/task attempt completion uses existing attempt worker completion path to complete the branch node.
- Branch workflow case completion uses existing child workflow terminal handling to complete/fail the branch node.

Non-goals:

- Do not implement `parallel`.
- Do not implement `mapTask` or `mapWorkflow`.
- Do not support nested branch/parallel/map subgraphs inside branch cases.
- Do not change public API shape.

---

## Task 1: Store Contract For Selected Branch Case

**Files:**

- Modify: `packages/workflows/src/runtime/store.ts`
- Modify: `packages/workflows/tests/support/in-memory-runtime.ts`
- Test: `packages/workflows/tests/runtime-interfaces.spec.ts`
- Test: `packages/workflows/tests/runtime-store.spec.ts`

- [ ] **Step 1: Add failing interface/export test**

Add imports in `packages/workflows/tests/runtime-interfaces.spec.ts`:

```ts
import type { SelectNodeCaseParams, WorkflowStore } from '../src/index.ts'
```

Add this test:

```ts
it('exports selected branch case store contract', () => {
  expectTypeOf<SelectNodeCaseParams>().toMatchTypeOf<{
    runId: string
    nodeName: string
    caseKey: string
  }>()

  expectTypeOf<WorkflowStore>().toHaveProperty('selectNodeCase')
})
```

- [ ] **Step 2: Run interface test to verify it fails**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts --reporter=agent
```

Expected: FAIL with missing `SelectNodeCaseParams` export or missing `WorkflowStore.selectNodeCase`.

- [ ] **Step 3: Add store contract**

Add to `packages/workflows/src/runtime/store.ts` near other semantic params:

```ts
export type SelectNodeCaseParams = {
  readonly runId: string
  readonly nodeName: string
  readonly caseKey: string
}
```

Add to `WorkflowStore`:

```ts
selectNodeCase(params: SelectNodeCaseParams): Promise<StoredNode | undefined>
```

Ensure `packages/workflows/src/index.ts` still re-exports runtime store types through existing exports. If `SelectNodeCaseParams` is not exported from root by existing wildcard export, add the missing export in the same style as other runtime store contracts.

- [ ] **Step 4: Add store behavior tests**

Add to `packages/workflows/tests/runtime-store.spec.ts`:

```ts
it('persists selected node case idempotently', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: 'branch-workflow',
    input: {},
  })
  await runtime.store.createNode({
    runId: run.id,
    name: 'choice',
    kind: 'branch',
  })

  const first = await runtime.store.selectNodeCase({
    runId: run.id,
    nodeName: 'choice',
    caseKey: 'normal',
  })
  const second = await runtime.store.selectNodeCase({
    runId: run.id,
    nodeName: 'choice',
    caseKey: 'normal',
  })

  expect(first?.selectedCase).toBe('normal')
  expect(second?.selectedCase).toBe('normal')
  expect(second?.version).toBe(first?.version)
})

it('rejects conflicting selected node case', async () => {
  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: 'branch-workflow',
    input: {},
  })
  await runtime.store.createNode({
    runId: run.id,
    name: 'choice',
    kind: 'branch',
  })
  await runtime.store.selectNodeCase({
    runId: run.id,
    nodeName: 'choice',
    caseKey: 'normal',
  })

  await expect(
    runtime.store.selectNodeCase({
      runId: run.id,
      nodeName: 'choice',
      caseKey: 'fallback',
    }),
  ).rejects.toThrow('Conflicting selected case')
})
```

- [ ] **Step 5: Run store tests to verify they fail**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-store.spec.ts --reporter=agent
```

Expected: FAIL because `selectNodeCase` is not implemented.

- [ ] **Step 6: Implement in-memory store method**

Add to `packages/workflows/tests/support/in-memory-runtime.ts` inside the `store` object:

```ts
async selectNodeCase({ runId, nodeName, caseKey }) {
  const key = nodeKey(runId, nodeName)
  const node = nodes.get(key)
  if (!node) return undefined
  if (node.selectedCase === caseKey) return node
  if (node.selectedCase !== undefined) {
    throw new Error(
      `Conflicting selected case for [${runId}.${nodeName}]: [${node.selectedCase}] != [${caseKey}]`,
    )
  }

  const updated: StoredNode = {
    ...node,
    selectedCase: caseKey,
    version: node.version + 1,
    updatedAt: now(),
  }
  nodes.set(key, updated)
  return updated
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts tests/runtime-store.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workflows/src/runtime/store.ts packages/workflows/tests/support/in-memory-runtime.ts packages/workflows/tests/runtime-interfaces.spec.ts packages/workflows/tests/runtime-store.spec.ts
git commit -m "feat: add selected branch case store contract"
```

---

## Task 2: Branch Activity Case Runtime Tests

**Files:**

- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`
- Test: `packages/workflows/tests/runtime-worker.spec.ts`

- [ ] **Step 1: Add branch activity success test**

Add to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
it('runs a branch activity case and completes from selected output', async () => {
  const workflow = defineWorkflow({
    name: 'branch-activity-workflow',
    input: t.object({
      kind: t.union(t.literal('normal'), t.literal('fallback')),
      scenario: t.string(),
    }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.union(t.literal('normal'), t.literal('fallback')),
      cases: ({ activity }) => ({
        normal: activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        fallback: activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
      }),
    })
    .build()

  let selectCalls = 0
  const implementation = implementWorkflow(workflow)
    .content({
      select: (_ctx, _outputs, input) => {
        selectCalls += 1
        return input.kind
      },
      cases: ({ activity }) => ({
        normal: activity(
          async (_ctx, input) => ({ text: `normal:${input.scenario}` }),
          {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          },
        ),
        fallback: activity(
          async (_ctx, input) => ({ text: `fallback:${input.scenario}` }),
          {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          },
        ),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { kind: 'normal', scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'coordinator',
    command: {
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    },
  })

  const afterDispatch = await runtime.store.loadRunSnapshot(run.id)
  expect(afterDispatch?.nodes[0]?.selectedCase).toBe('normal')
  expect(afterDispatch?.nodes[0]?.status).toBe('waiting')
  expect(runtime.inspect().activityCommands).toHaveLength(1)
  expect(runtime.inspect().activityCommands[0]?.payload).toMatchObject({
    kind: 'activityAttempt',
    workflowName: workflow.name,
    activityName: 'content.normal',
    runId: run.id,
    nodeName: 'content',
    input: { scenario: 'alpha' },
  })

  const claimed = await runtime.attemptExecutor.claimActivity({
    workerId: 'activity-worker',
    workflowNames: [workflow.name],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()

  await runActivityAttempt({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'activity-worker',
    claimed: claimed!,
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'coordinator',
    command: {
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    },
  })

  const final = await runtime.store.loadRunSnapshot(run.id)
  expect(selectCalls).toBe(1)
  expect(final?.nodes[0]?.status).toBe('completed')
  expect(final?.nodes[0]?.selectedCase).toBe('normal')
  expect(final?.nodes[0]?.output).toStrictEqual({ text: 'normal:alpha' })
  expect(final?.run.status).toBe('completed')
  expect(final?.run.output).toStrictEqual({ text: 'normal:alpha' })
})
```

Use the actual branch declaration helper signature from `contract/index.ts` if this snippet drifts. Keep assertions: selected case persisted, one activity command, branch output is raw selected output, select called once.

- [ ] **Step 2: Add duplicate continuation test**

Add to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
it('does not reselect or duplicate branch activity attempts on repeated continuation', async () => {
  const workflow = defineWorkflow({
    name: 'branch-activity-dedupe',
    input: t.object({ kind: t.literal('normal'), scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('normal'),
      cases: ({ activity }) => ({
        normal: activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
      }),
    })
    .build()

  let selectCalls = 0
  const implementation = implementWorkflow(workflow)
    .content({
      select: () => {
        selectCalls += 1
        return 'normal'
      },
      cases: ({ activity }) => ({
        normal: activity(async (_ctx, input) => ({ text: input.scenario }), {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { kind: 'normal', scenario: 'alpha' },
  })
  const command = {
    kind: 'continueRun' as const,
    runId: run.id,
    workflowName: workflow.name,
  }

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'coordinator',
    command,
  })
  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'coordinator',
    command,
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(selectCalls).toBe(1)
  expect(snapshot?.attempts).toHaveLength(1)
  expect(runtime.inspect().activityCommands).toHaveLength(2)
  expect(
    runtime.inspect().activityCommands.map((item) => item.payload.attemptId),
  ).toEqual([
    runtime.inspect().activityCommands[0]!.payload.attemptId,
    runtime.inspect().activityCommands[0]!.payload.attemptId,
  ])
})
```

The expected command count is `2` because retrying after a possible enqueue loss may re-enqueue the same attempt command. The important assertions are one persisted attempt and same attempt id.

- [ ] **Step 3: Run tests to verify branch runtime fails**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: FAIL with `Unsupported runtime node kind [branch]` or activity worker unable to resolve branch case handler.

- [ ] **Step 4: Commit tests**

Do not commit passing code in this task. Commit failing tests only if following strict TDD checkpoint policy is desired; otherwise leave uncommitted for Task 3. If committing tests, use:

```bash
git add packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "test: cover branch activity runtime"
```

---

## Task 3: Branch Activity Runtime Implementation

**Files:**

- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Modify: `packages/workflows/src/runtime/worker.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`
- Test: `packages/workflows/tests/runtime-worker.spec.ts`

- [ ] **Step 1: Add branch node dispatch route**

In `packages/workflows/src/runtime/coordinator.ts`, import `BranchNodeImplementation`:

```ts
import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  RunnableNodeImplementation,
  WorkflowImplementation,
  WorkflowCaseImplementation,
} from '../implement/index.ts'
```

In `advanceWorkflowRun`, add branch before unsupported throw:

```ts
if (nextNode.kind === 'branch') {
  await dispatchBranchNode({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: input.workflow,
    workflowCtx: input.workflowCtx,
    run: input.run,
    outputs: input.outputs,
    node: nextNode,
  })
  return
}
```

- [ ] **Step 2: Extract primitive attempt dispatch helper**

Add a helper to avoid duplicating top-level and branch attempt logic:

```ts
async function dispatchActivityAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly identity?: {
    readonly runId: string
    readonly nodeName: string
    readonly caseKey?: string
  }
  readonly input: unknown
}) {
  const result = input.identity
    ? await input.store.ensureNodeAttempt({
        identity: input.identity,
        kind: 'activity',
        input: input.input,
      })
    : {
        attempt: await input.store.createAttempt({
          runId: input.runId,
          nodeName: input.nodeName,
          input: input.input,
        }),
        created: true,
      }

  await input.attemptExecutor.dispatchActivity({
    kind: 'activityAttempt',
    workflowName: input.workflowName,
    activityName: input.activityName,
    runId: input.runId,
    nodeName: input.nodeName,
    attemptId: result.attempt.id,
    leaseToken: result.attempt.leaseToken!,
    input: input.input,
  })
}
```

Add equivalent `dispatchTaskAttempt` for task attempts.

Top-level `dispatchActivityNode` and `dispatchTaskNode` may keep `createAttempt` directly or call these helpers with no identity. Branch must use identities with `caseKey`.

- [ ] **Step 3: Implement branch activity case dispatch**

Add:

```ts
async function dispatchBranchNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: BranchNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'branch',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  const caseKey =
    existing.selectedCase ??
    input.node.select(input.workflowCtx, input.outputs, input.run.input)

  await input.store.selectNodeCase({
    runId: input.run.id,
    nodeName: input.node.name,
    caseKey,
  })

  const selected = input.node.cases[caseKey]
  if (!selected) {
    const error = new Error(
      `Unknown branch case [${input.node.name}.${caseKey}]`,
    )
    await input.store.failNode({
      runId: input.run.id,
      nodeName: input.node.name,
      error,
    })
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      error,
    })
    return
  }

  if (selected.kind === 'activity') {
    const nodeInput = selected.input
      ? selected.input(input.workflowCtx, input.outputs, input.run.input)
      : input.run.input
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: nodeInput,
    })
    await dispatchActivityAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      activityName: selected.activity.name,
      runId: input.run.id,
      nodeName: input.node.name,
      identity: {
        runId: input.run.id,
        nodeName: input.node.name,
        caseKey,
      },
      input: nodeInput,
    })
    await input.store.waitNode({
      runId: input.run.id,
      nodeName: input.node.name,
    })
    return
  }

  throw new Error(`Unsupported branch case kind [${selected.kind}]`)
}
```

After later steps, remove the temporary unsupported throw for `task` and `workflow`.

- [ ] **Step 4: Resolve branch inline activity in worker**

In `packages/workflows/src/runtime/worker.ts`, replace direct top-level activity lookup with helper:

```ts
function findActivityForAttempt(input: {
  readonly workflow: WorkflowImplementation
  readonly storedNode: StoredNode
  readonly activityName: string
}): ActivityNodeImplementation['activity'] | undefined {
  const topLevel = input.workflow.nodes.find(
    (candidate): candidate is ActivityNodeImplementation =>
      candidate.kind === 'activity' && candidate.name === input.storedNode.name,
  )
  if (topLevel?.activity.name === input.activityName) return topLevel.activity

  const branch = input.workflow.nodes.find(
    (candidate) =>
      candidate.kind === 'branch' && candidate.name === input.storedNode.name,
  )
  const selectedCase = input.storedNode.selectedCase
  if (!branch || !selectedCase) return undefined

  const selected = branch.cases[selectedCase]
  if (selected?.kind !== 'activity') return undefined
  if (selected.activity.name !== input.activityName) return undefined
  return selected.activity
}
```

Use it in `runActivityAttempt`:

```ts
const activity = findActivityForAttempt({
  workflow,
  storedNode,
  activityName: command.activityName,
})
if (!activity) {
  await input.attemptExecutor.release(input.claimed)
  return
}

const ctx = await input.container.createContext(activity.dependencies)
output = await activity.handler(ctx as DependencyContext<any>, command.input)
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: branch activity tests PASS; branch task/workflow not yet covered.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/runtime/coordinator.ts packages/workflows/src/runtime/worker.ts packages/workflows/tests/runtime-coordinator.spec.ts packages/workflows/tests/runtime-worker.spec.ts
git commit -m "feat: run branch activity cases"
```

---

## Task 4: Branch Task Case Runtime

**Files:**

- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add branch task success test**

Add to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
it('runs a branch task case and completes from selected output', async () => {
  const task = defineTask({
    name: 'branch.generate-summary',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
  const workflow = defineWorkflow({
    name: 'branch-task-workflow',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('summary'),
      cases: ({ task: taskCase }) => ({
        summary: taskCase(task),
      }),
    })
    .build()

  const taskImplementation = implementTask(task, {
    handler: async (_ctx, input) => ({ text: `task:${input.scenario}` }),
  })
  const workflowImplementation = implementWorkflow(workflow)
    .content({
      select: () => 'summary',
      cases: ({ task: taskCase }) => ({
        summary: taskCase(task, {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [workflowImplementation],
    workerId: 'coordinator',
    command: {
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    },
  })

  expect(runtime.inspect().taskCommands[0]?.payload).toMatchObject({
    kind: 'taskAttempt',
    workflowName: workflow.name,
    taskName: task.name,
    nodeName: 'content',
    input: { scenario: 'alpha' },
  })

  const claimed = await runtime.attemptExecutor.claimTask({
    workerId: 'task-worker',
    workflowNames: [workflow.name],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()

  await runTaskAttempt({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    tasks: [taskImplementation],
    workerId: 'task-worker',
    claimed: claimed!,
  })
  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [workflowImplementation],
    workerId: 'coordinator',
    command: {
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    },
  })

  const final = await runtime.store.loadRunSnapshot(run.id)
  expect(final?.run.status).toBe('completed')
  expect(final?.run.output).toStrictEqual({ text: 'task:alpha' })
})
```

- [ ] **Step 2: Implement branch task dispatch**

In `dispatchBranchNode`, add before workflow/unsupported handling:

```ts
if (selected.kind === 'task') {
  const nodeInput = selected.input
    ? selected.input(input.workflowCtx, input.outputs, input.run.input)
    : input.run.input
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })
  await dispatchTaskAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    taskName: selected.target.name,
    runId: input.run.id,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
      caseKey,
    },
    input: nodeInput,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  return
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/workflows/src/runtime/coordinator.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: run branch task cases"
```

---

## Task 5: Branch Child Workflow Case Runtime

**Files:**

- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add branch child workflow success test**

Add to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
it('runs a branch child workflow case on a separate worker', async () => {
  const childWorkflow = defineWorkflow({
    name: 'branch-child-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'branch-child-parent',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('child'),
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow),
      }),
    })
    .build()

  const childImplementation = implementWorkflow(childWorkflow).finish(
    (_ctx, _outputs, input) => ({ text: `child:${input.scenario}` }),
  )
  const parentImplementation = implementWorkflow(parentWorkflow)
    .content({
      select: () => 'child',
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow, {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

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

  const parentWaiting = await runtime.store.loadRunSnapshot(parentRun.id)
  const link = parentWaiting!.childLinks[0]!
  expect(link.caseKey).toBe('child')
  expect(link.workflowName).toBe(childWorkflow.name)

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [childImplementation],
    workerId: 'child-coordinator',
    command: {
      kind: 'continueRun',
      runId: link.childRunId,
      workflowName: childWorkflow.name,
    },
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

  const final = await runtime.store.loadRunSnapshot(parentRun.id)
  expect(final?.nodes[0]?.status).toBe('completed')
  expect(final?.nodes[0]?.output).toStrictEqual({ text: 'child:alpha' })
  expect(final?.run.status).toBe('completed')
})
```

- [ ] **Step 2: Extract generic child workflow helper**

In `packages/workflows/src/runtime/coordinator.ts`, extract direct child workflow logic into a helper that accepts `identity` and child target. Use this helper signature:

```ts
async function dispatchChildWorkflow(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly nodeName: string
  readonly identity: {
    readonly runId: string
    readonly nodeName: string
    readonly caseKey?: string
  }
  readonly workflowName: string
  readonly nodeInput: unknown
}): Promise<void>
```

Move the existing direct `.workflow` child-link branches from `dispatchWorkflowNode` into `dispatchChildWorkflow`, with these exact argument substitutions:

- direct child workflow calls pass `identity: { runId: input.run.id, nodeName: input.node.name }`
- branch workflow case calls pass `identity: { runId: input.run.id, nodeName: input.node.name, caseKey }`
- `workflowName` replaces `input.node.target.name`
- `nodeName` replaces `input.node.name`
- `nodeInput` replaces the locally computed child input

The helper must preserve current recovery behavior:

- if existing child link is non-terminal, enqueue child continuation and wait parent node
- if child completed, complete parent node and call `advanceWorkflowRun`
- if child failed/cancelled, fail parent node and run
- if child link is missing, `ensureChildWorkflowRun`, enqueue child continuation, wait parent node
- if child enqueue throws after child link persisted, retry re-enqueues child
- if parent wake enqueue throws after child terminal state, retry child continuation wakes parent

- [ ] **Step 3: Implement branch workflow case dispatch**

In `dispatchBranchNode`, add:

```ts
if (selected.kind === 'workflow') {
  const nodeInput = selected.input
    ? selected.input(input.workflowCtx, input.outputs, input.run.input)
    : input.run.input
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })
  await dispatchChildWorkflow({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: input.workflow,
    workflowCtx: input.workflowCtx,
    run: input.run,
    outputs: input.outputs,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
      caseKey,
    },
    workflowName: selected.target.name,
    nodeInput,
  })
  return
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/runtime/coordinator.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: run branch workflow cases"
```

---

## Task 6: Branch Failure And Recovery Coverage

**Files:**

- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add unknown selected case test**

Add:

```ts
it('fails the run when a branch selects an unknown case', async () => {
  const workflow = defineWorkflow({
    name: 'branch-unknown-case',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('normal'),
      cases: ({ activity }) => ({
        normal: activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
      }),
    })
    .build()

  const implementation = implementWorkflow(workflow)
    .content({
      select: () => 'missing' as 'normal',
      cases: ({ activity }) => ({
        normal: activity(async (_ctx, input) => ({ text: input.scenario })),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [implementation],
    workerId: 'coordinator',
    command: {
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    },
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.nodes[0]?.status).toBe('failed')
  expect(snapshot?.nodes[0]?.selectedCase).toBe('missing')
  expect(snapshot?.run.status).toBe('failed')
})
```

- [ ] **Step 2: Add child enqueue recovery test for branch workflow case**

Add:

```ts
it('re-enqueues a branch child workflow when enqueue fails after link creation', async () => {
  const childWorkflow = defineWorkflow({
    name: 'branch-recover-child-enqueue-child',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'branch-recover-child-enqueue-parent',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('child'),
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow),
      }),
    })
    .build()
  const parentImplementation = implementWorkflow(parentWorkflow)
    .content({
      select: () => 'child',
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow, {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const container = createTestContainer()
  const parentRun = await runtime.store.createRun({
    workflowName: parentWorkflow.name,
    input: { scenario: 'alpha' },
  })
  let failedChildEnqueue = false
  const flakyRunCoordinationExecutor = {
    ...runtime.runCoordinationExecutor,
    async enqueue(command) {
      if (!failedChildEnqueue && command.workflowName === childWorkflow.name) {
        failedChildEnqueue = true
        throw new Error('child enqueue failed')
      }
      await runtime.runCoordinationExecutor.enqueue(command)
    },
  } satisfies typeof runtime.runCoordinationExecutor
  const command = {
    kind: 'continueRun' as const,
    runId: parentRun.id,
    workflowName: parentWorkflow.name,
  }

  await expect(
    continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: flakyRunCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    }),
  ).rejects.toThrow('child enqueue failed')

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: flakyRunCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [parentImplementation],
    workerId: 'parent-coordinator',
    command,
  })

  const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
  const childRunId = snapshot!.childLinks[0]!.childRunId
  expect(snapshot?.childLinks).toHaveLength(1)
  expect(
    runtime
      .inspect()
      .runs.filter((run) => run.workflowName === childWorkflow.name),
  ).toHaveLength(1)
  expect(
    runtime
      .inspect()
      .continueRunCommands.filter(
        (queued) => queued.payload.runId === childRunId,
      ),
  ).toHaveLength(1)
})
```

- [ ] **Step 3: Add parent wake recovery test for branch child workflow case**

Add:

```ts
it('retries parent wake for a completed branch child workflow', async () => {
  const childWorkflow = defineWorkflow({
    name: 'branch-recover-parent-wake-child',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'branch-recover-parent-wake-parent',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  })
    .branch('content', {
      select: t.literal('child'),
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow),
      }),
    })
    .build()
  const childImplementation = implementWorkflow(childWorkflow).finish(
    (_ctx, _outputs, input) => ({ text: `child:${input.scenario}` }),
  )
  const parentImplementation = implementWorkflow(parentWorkflow)
    .content({
      select: () => 'child',
      cases: ({ workflow }) => ({
        child: workflow(childWorkflow, {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }),
    })
    .finish((_ctx, { content }) => ({ text: content.text }))

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
  let failedParentWake = false
  const flakyRunCoordinationExecutor = {
    ...runtime.runCoordinationExecutor,
    async enqueue(command) {
      if (
        !failedParentWake &&
        command.runId === parentRun.id &&
        command.workflowName === parentWorkflow.name
      ) {
        failedParentWake = true
        throw new Error('parent wake failed')
      }
      await runtime.runCoordinationExecutor.enqueue(command)
    },
  } satisfies typeof runtime.runCoordinationExecutor
  const childCommand = {
    kind: 'continueRun' as const,
    runId: childRunId,
    workflowName: childWorkflow.name,
  }

  await expect(
    continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: flakyRunCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: childCommand,
    }),
  ).rejects.toThrow('parent wake failed')

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: flakyRunCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    container,
    workflows: [childImplementation],
    workerId: 'child-coordinator',
    command: childCommand,
  })

  expect(
    runtime
      .inspect()
      .continueRunCommands.some(
        (queued) =>
          queued.payload.runId === parentRun.id &&
          queued.payload.workflowName === parentWorkflow.name,
      ),
  ).toBe(true)
})
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-coordinator.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts tests/runtime-store.spec.ts tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/runtime/coordinator.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "test: cover branch runtime recovery"
```

---

## Task 7: Final Verification And Review

**Files:**

- Review all changed files in this plan.

- [ ] **Step 1: Run full focused runtime verification**

Run:

```bash
pnpm --filter @nmtjs/workflows exec vitest run tests/runtime-interfaces.spec.ts tests/runtime-store.spec.ts tests/runtime-coordinator.spec.ts tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
pnpm oxlint . --format=agent
```

Expected:

- Vitest: all focused runtime tests pass.
- Typecheck: exit 0.
- Oxlint: exit 0. Existing warnings in generated bench/demo/type-helper files may remain, but no new hard errors.

- [ ] **Step 2: Dependency boundary scan**

Run:

```bash
rg -n "bullmq|ioredis|iovalkey|redis|valkey|postgres|pg" packages/workflows/src/runtime packages/workflows/src/contract packages/workflows/src/implement
```

Expected: no adapter/runtime infrastructure imports in core workflow runtime/contract/implement.

- [ ] **Step 3: Manual checklist**

Verify:

- Branch `select` evaluated once.
- Selected case persisted in `StoredNode.selectedCase`.
- Unknown case fails node and run.
- Activity case uses attempt identity with `caseKey`.
- Task case uses attempt identity with `caseKey`.
- Workflow case uses child link identity with `caseKey`.
- Non-selected cases are not dispatched.
- Branch node output is selected case output, not wrapper object.
- Branch child workflow can run on a separate coordinator worker.
- Lost child enqueue recovery works for branch workflow cases.
- Lost parent wake recovery works for branch workflow cases.
- `parallel`, `mapTask`, and `mapWorkflow` still throw unsupported in runtime.

- [ ] **Step 4: Final code review**

Dispatch a reviewer or perform a review pass focused on:

- duplicate dispatch logic between direct workflow and branch workflow cases
- stale attempt recovery for branch activity/task attempts
- enqueue-after-persist recovery
- selected-case conflict handling
- tests that accidentally pass without executing worker path

- [ ] **Step 5: Commit final cleanup if needed**

If review produces fixes:

```bash
git add packages/workflows/src/runtime packages/workflows/tests
git commit -m "fix: polish branch runtime"
```

If no fixes are needed, do not create an empty commit.

---

## Acceptance Criteria

- `branch` nodes execute exactly one selected primitive case.
- Branch `select` callback runs once per branch node.
- Selected case is durable and visible as `StoredNode.selectedCase`.
- Activity cases dispatch and complete through activity worker path.
- Task cases dispatch and complete through task worker path.
- Workflow cases create child runs and can execute on separate workflow workers.
- Duplicate continuations do not create duplicate attempts or child runs.
- Lost child/parent continuation enqueues are recoverable for branch workflow cases.
- Unknown selected case fails the run.
- Branch node output is the selected case output.
- `parallel`, `mapTask`, and `mapWorkflow` remain unsupported for this slice.

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-06-29-workflows-branch-runtime.md`.

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task with review between tasks.
2. **Inline Execution** - execute tasks in this session with checkpoints.
