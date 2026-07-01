# Workflows Runtime Core Implementation Plan

> **Superseded task-run note (2026-06-29):** this plan predates the decision
> that tasks are first-class durable runs. Sections describing workflow task
> nodes as direct task attempts are historical implementation slices, not the
> target model for new work. New runtime work should model tasks as task runs
> with internal attempts.

> **Current status (2026-06-30):** this plan is historical. The adapter-free
> runtime now lives under `packages/workflows/src/runtime`, and the in-memory
> runtime is test support under `packages/workflows/tests/support`, not a public
> `src/testing` subpath. Use
> `docs/superpowers/specs/2026-06-29-workflows-runtime-model-design.md` as the
> current runtime source of truth. Do not execute the task list below for new
> work without revalidating every path and API name against the current source.

> **Postgres-first pivot (2026-07-01):** this plan also predates the decision
> that Postgres is the v1 durable runtime substrate. Store/executor interfaces
> may remain internal/transitional, but new runtime work should not optimize for
> interchangeable BullMQ/cloud/in-memory backends. Use
> `docs/superpowers/plans/2026-07-01-workflows-postgres-first-runtime.md` for
> the next implementation slice.

> **Historical agent instruction:** this originally used
> superpowers:subagent-driven-development or superpowers:executing-plans. That
> instruction is preserved as context only; it is not current guidance.

**Goal:** Build the first adapter-free workflows runtime slice: interfaces, in-memory test store/executors, primitive activity/task continuation, and worker concurrency wrapper.

**Architecture:** Runtime state lives behind semantic store interfaces. `RunCoordinationExecutor` handles idempotent `continueRun` commands, while `AttemptExecutor` handles leased activity/task attempts. The first implementation uses in-memory adapters to prove semantics before BullMQ, SQL, or any durable adapter exists.

**Tech Stack:** TypeScript, Vitest, `@nmtjs/workflows` existing contract/implement APIs, `@nmtjs/core` dependency handlers, `@nmtjs/type` schemas.

---

## File Structure

- Create `packages/workflows/src/runtime/status.ts`
  - Runtime status unions and terminal-state guards.
- Create `packages/workflows/src/runtime/commands.ts`
  - `ContinueRunCommand`, attempt command, claim, worker claim, and lease token types.
- Create `packages/workflows/src/runtime/state.ts`
  - Stored run, node, attempt, child link, and map item types.
- Create `packages/workflows/src/runtime/store.ts`
  - Semantic `WorkflowStore` interface. No CRUD-only API.
- Create `packages/workflows/src/runtime/executors.ts`
  - `RunCoordinationExecutor` and `AttemptExecutor` interfaces.
- Create `packages/workflows/src/runtime/registry.ts`
  - Runtime registration helpers for workflow/task implementations and routeability checks.
- Create `packages/workflows/src/runtime/coordinator.ts`
  - `continueRun` engine that advances one locked run.
- Create `packages/workflows/src/runtime/worker.ts`
  - Small worker loop with concurrency slots for continuation and attempts.
- Create `packages/workflows/src/runtime/index.ts`
  - Runtime exports.
- Create `packages/workflows/src/testing/in-memory-runtime.ts`
  - In-memory `WorkflowStore`, `RunCoordinationExecutor`, and `AttemptExecutor`.
- Create `packages/workflows/src/testing/index.ts`
  - Testing exports.
- Modify `packages/workflows/src/index.ts`
  - Export runtime types and helpers that are safe from adapter dependencies.
- Modify `packages/workflows/package.json`
  - Add optional `./runtime` and `./testing` subpath exports.
- Create `packages/workflows/tests/runtime-interfaces.spec.ts`
  - Type and boundary tests for public runtime interfaces.
- Create `packages/workflows/tests/runtime-store.spec.ts`
  - Store semantic behavior tests.
- Create `packages/workflows/tests/runtime-coordinator.spec.ts`
  - Activity/task continuation tests.
- Create `packages/workflows/tests/runtime-worker.spec.ts`
  - Worker concurrency and routeability tests.

---

### Task 1: Runtime Interface Surface

**Files:**
- Create: `packages/workflows/src/runtime/status.ts`
- Create: `packages/workflows/src/runtime/commands.ts`
- Create: `packages/workflows/src/runtime/state.ts`
- Create: `packages/workflows/src/runtime/store.ts`
- Create: `packages/workflows/src/runtime/executors.ts`
- Create: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/tests/runtime-interfaces.spec.ts`

- [ ] **Step 1: Write failing interface/export test**

Create `packages/workflows/tests/runtime-interfaces.spec.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest'

import type {
  AttemptCommand,
  AttemptExecutor,
  ContinueRunCommand,
  RunCoordinationExecutor,
  StoredAttempt,
  StoredNode,
  StoredRun,
  WorkflowStore,
} from '../src/index.ts'

describe('workflow runtime interfaces', () => {
  it('exports adapter-free runtime contracts from the root package', () => {
    expectTypeOf<ContinueRunCommand>().toMatchTypeOf<{
      kind: 'continueRun'
      runId: string
      workflowName: string
    }>()

    expectTypeOf<AttemptCommand>().toMatchTypeOf<{
      attemptId: string
      leaseToken: string
      workflowName: string
      runId: string
      nodeName: string
    }>()

    expectTypeOf<RunCoordinationExecutor>().toHaveProperty('enqueue')
    expectTypeOf<AttemptExecutor>().toHaveProperty('dispatchActivity')
    expectTypeOf<WorkflowStore>().toHaveProperty('createRun')
    expectTypeOf<StoredRun>().toHaveProperty('status')
    expectTypeOf<StoredNode>().toHaveProperty('status')
    expectTypeOf<StoredAttempt>().toHaveProperty('status')
  })
})
```

- [ ] **Step 2: Run test to verify missing exports**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-interfaces.spec.ts --reporter=agent
```

Expected: FAIL with missing exported members such as `ContinueRunCommand`.

- [ ] **Step 3: Add status types**

Create `packages/workflows/src/runtime/status.ts`:

```ts
export type RuntimeRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type RuntimeNodeStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type RuntimeAttemptStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'

export function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isTerminalNodeStatus(status: RuntimeNodeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
```

- [ ] **Step 4: Add command types**

Create `packages/workflows/src/runtime/commands.ts`:

```ts
export type ContinueRunCommand = {
  readonly kind: 'continueRun'
  readonly runId: string
  readonly workflowName: string
}

export type ActivityAttemptCommand = {
  readonly kind: 'activityAttempt'
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
  readonly leaseToken: string
  readonly input: unknown
}

export type TaskAttemptCommand = {
  readonly kind: 'taskAttempt'
  readonly workflowName: string
  readonly taskName: string
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
  readonly leaseToken: string
  readonly input: unknown
}

export type AttemptCommand = ActivityAttemptCommand | TaskAttemptCommand

export type ClaimedCommand = {
  readonly id: string
  readonly command: ContinueRunCommand
  readonly leaseToken: string
}

export type ClaimedAttempt = {
  readonly id: string
  readonly command: AttemptCommand
  readonly leaseToken: string
}

export type RunCoordinationWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly leaseMs: number
}

export type ActivityWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly activityNames?: readonly string[]
  readonly leaseMs: number
}

export type TaskWorkerClaim = {
  readonly workerId: string
  readonly taskNames: readonly string[]
  readonly leaseMs: number
}
```

- [ ] **Step 5: Add stored state types**

Create `packages/workflows/src/runtime/state.ts`:

```ts
import type { WorkflowNodeKind } from '../types/index.ts'
import type {
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from './status.ts'

export type StoredError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
}

export type StoredRun = {
  readonly id: string
  readonly workflowName: string
  readonly status: RuntimeRunStatus
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId: string
  readonly tags: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type StoredNode = {
  readonly runId: string
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly status: RuntimeNodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly selectedCase?: string
  readonly currentAttemptId?: string
  readonly nextAttemptAt?: Date
  readonly attemptCount: number
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
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
  readonly itemIndex?: number
}

export type StoredMapItem = {
  readonly runId: string
  readonly nodeName: string
  readonly index: number
  readonly key?: string
  readonly item: unknown
  readonly status: RuntimeNodeStatus
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly attemptId?: string
}

export type RunSnapshot = {
  readonly run: StoredRun
  readonly nodes: readonly StoredNode[]
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}
```

- [ ] **Step 6: Add store and executor interfaces**

Create `packages/workflows/src/runtime/store.ts`:

```ts
import type { WorkflowNodeKind } from '../types/index.ts'
import type { RunSnapshot, StoredAttempt, StoredNode, StoredRun } from './state.ts'

export type RunLease = {
  readonly runId: string
  readonly leaseToken: string
  readonly version: number
}

export type CreateRunInput = {
  readonly workflowName: string
  readonly input: unknown
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId?: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type CreateNodeInput = {
  readonly runId: string
  readonly name: string
  readonly kind: WorkflowNodeKind
}

export type CreateAttemptInput = {
  readonly runId: string
  readonly nodeName: string
  readonly input: unknown
}

export type WorkflowStore = {
  createRun(input: CreateRunInput): Promise<StoredRun>
  acquireRunLease(params: {
    runId: string
    workerId: string
    leaseMs: number
  }): Promise<RunLease | undefined>
  releaseRunLease(lease: RunLease): Promise<void>
  loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined>
  createNode(input: CreateNodeInput): Promise<StoredNode>
  setNodeInput(params: {
    runId: string
    nodeName: string
    input: unknown
  }): Promise<StoredNode>
  createAttempt(input: CreateAttemptInput): Promise<StoredAttempt>
  completeCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    output: unknown
  }): Promise<StoredAttempt | undefined>
  failCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    error: unknown
  }): Promise<StoredAttempt | undefined>
  completeNode(params: {
    runId: string
    nodeName: string
    output: unknown
  }): Promise<StoredNode | undefined>
  failNode(params: {
    runId: string
    nodeName: string
    error: unknown
  }): Promise<StoredNode | undefined>
  completeRun(params: {
    runId: string
    output: unknown
  }): Promise<StoredRun | undefined>
  failRun(params: {
    runId: string
    error: unknown
  }): Promise<StoredRun | undefined>
}
```

Create `packages/workflows/src/runtime/executors.ts`:

```ts
import type {
  ActivityAttemptCommand,
  ActivityWorkerClaim,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  RunCoordinationWorkerClaim,
  TaskAttemptCommand,
  TaskWorkerClaim,
} from './commands.ts'

export type RunCoordinationExecutor = {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Date): Promise<void>
  claim(worker: RunCoordinationWorkerClaim): Promise<ClaimedCommand | null>
  ack(command: ClaimedCommand): Promise<void>
  release(command: ClaimedCommand): Promise<void>
}

export type AttemptExecutor = {
  dispatchActivity(command: ActivityAttemptCommand): Promise<void>
  dispatchTask(command: TaskAttemptCommand): Promise<void>
  claimActivity(worker: ActivityWorkerClaim): Promise<ClaimedAttempt | null>
  claimTask(worker: TaskWorkerClaim): Promise<ClaimedAttempt | null>
  heartbeat(attempt: ClaimedAttempt): Promise<void>
  ack(attempt: ClaimedAttempt): Promise<void>
  release(attempt: ClaimedAttempt): Promise<void>
}
```

- [ ] **Step 7: Export runtime types**

Create `packages/workflows/src/runtime/index.ts`:

```ts
export type {
  ActivityAttemptCommand,
  ActivityWorkerClaim,
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  RunCoordinationWorkerClaim,
  TaskAttemptCommand,
  TaskWorkerClaim,
} from './commands.ts'
export type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
export type {
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from './status.ts'
export { isTerminalNodeStatus, isTerminalRunStatus } from './status.ts'
export type {
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from './state.ts'
export type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  RunLease,
  WorkflowStore,
} from './store.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export type {
  ActivityAttemptCommand,
  ActivityWorkerClaim,
  AttemptCommand,
  AttemptExecutor,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  RunCoordinationExecutor,
  RunCoordinationWorkerClaim,
  RunLease,
  RunSnapshot,
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
  TaskAttemptCommand,
  TaskWorkerClaim,
  WorkflowStore,
} from './runtime/index.ts'
export { isTerminalNodeStatus, isTerminalRunStatus } from './runtime/index.ts'
```

Add these exports after existing type exports. Do not remove existing exports.

- [ ] **Step 8: Run test and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-interfaces.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-interfaces.spec.ts
git commit -m "feat: add workflow runtime interfaces"
```

---

### Task 2: In-Memory Store Semantics

**Files:**
- Create: `packages/workflows/src/testing/in-memory-runtime.ts`
- Create: `packages/workflows/src/testing/index.ts`
- Modify: `packages/workflows/package.json`
- Test: `packages/workflows/tests/runtime-store.spec.ts`

- [ ] **Step 1: Write failing store tests**

Create `packages/workflows/tests/runtime-store.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/testing/index.ts'

describe('in-memory workflow store', () => {
  it('creates runs, leases one coordinator at a time, and releases leases', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    const firstLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-1',
      leaseMs: 30_000,
    })
    const secondLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-2',
      leaseMs: 30_000,
    })

    expect(firstLease).toBeDefined()
    expect(secondLease).toBeUndefined()

    await runtime.store.releaseRunLease(firstLease!)

    const thirdLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-2',
      leaseMs: 30_000,
    })

    expect(thirdLease).toBeDefined()
  })

  it('persists node input before attempts and ignores stale completions', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    await runtime.store.setNodeInput({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })
    const firstAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })

    const stale = await runtime.store.completeCurrentAttempt({
      attemptId: firstAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      output: { text: 'stale' },
    })
    const fresh = await runtime.store.completeCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      output: { text: 'fresh' },
    })

    expect(stale).toBeUndefined()
    expect(fresh?.output).toStrictEqual({ text: 'fresh' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'a' })
  })
})
```

- [ ] **Step 2: Run test to verify missing testing runtime**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-store.spec.ts --reporter=agent
```

Expected: FAIL because `../src/testing/index.ts` does not exist.

- [ ] **Step 3: Implement in-memory runtime store**

Create `packages/workflows/src/testing/in-memory-runtime.ts` with these exports and behavior:

```ts
import type { WorkflowNodeKind } from '../types/index.ts'
import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
} from '../runtime/commands.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../runtime/executors.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  RunLease,
  WorkflowStore,
} from '../runtime/store.ts'
import type {
  RunSnapshot,
  StoredAttempt,
  StoredMapItem,
  StoredChildLink,
  StoredNode,
  StoredRun,
} from '../runtime/state.ts'

type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
}

export type InMemoryWorkflowRuntime = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly inspect: () => {
    readonly runs: readonly StoredRun[]
    readonly nodes: readonly StoredNode[]
    readonly attempts: readonly StoredAttempt[]
    readonly continueRunCommands: readonly QueueItem<ContinueRunCommand>[]
    readonly activityCommands: readonly QueueItem<ActivityAttemptCommand>[]
  }
}

export function createInMemoryWorkflowRuntime(): InMemoryWorkflowRuntime {
  let nextId = 1
  const ids = (prefix: string) => `${prefix}-${nextId++}`
  const now = () => new Date()

  const runs = new Map<string, StoredRun>()
  const nodes = new Map<string, StoredNode>()
  const attempts = new Map<string, StoredAttempt>()
  const childLinks: StoredChildLink[] = []
  const mapItems: StoredMapItem[] = []
  const runLeases = new Map<string, RunLease>()
  const continueQueue: QueueItem<ContinueRunCommand>[] = []
  const activityQueue: QueueItem<ActivityAttemptCommand>[] = []
  const taskQueue: QueueItem<any>[] = []

  const nodeKey = (runId: string, name: string) => `${runId}:${name}`

  const store: WorkflowStore = {
    async createRun(input: CreateRunInput) {
      const date = now()
      const id = ids('run')
      const run: StoredRun = {
        id,
        workflowName: input.workflowName,
        status: 'queued',
        input: input.input,
        parentRunId: input.parentRunId,
        parentNodeName: input.parentNodeName,
        rootRunId: input.rootRunId ?? id,
        tags: input.tags ?? {},
        idempotencyKey: input.idempotencyKey,
        version: 1,
        createdAt: date,
        updatedAt: date,
      }
      runs.set(id, run)
      return run
    },
    async acquireRunLease({ runId }) {
      if (runLeases.has(runId)) return undefined
      const run = runs.get(runId)
      if (!run) return undefined
      const lease: RunLease = {
        runId,
        leaseToken: ids('run-lease'),
        version: run.version,
      }
      runLeases.set(runId, lease)
      return lease
    },
    async releaseRunLease(lease) {
      if (runLeases.get(lease.runId)?.leaseToken === lease.leaseToken) {
        runLeases.delete(lease.runId)
      }
    },
    async loadRunSnapshot(runId) {
      const run = runs.get(runId)
      if (!run) return undefined
      return {
        run,
        nodes: [...nodes.values()].filter((node) => node.runId === runId),
        attempts: [...attempts.values()].filter((attempt) => attempt.runId === runId),
        childLinks: childLinks.filter((link) => link.parentRunId === runId),
        mapItems: mapItems.filter((item) => item.runId === runId),
      }
    },
    async createNode(input: CreateNodeInput) {
      const key = nodeKey(input.runId, input.name)
      const existing = nodes.get(key)
      if (existing) return existing
      const date = now()
      const node: StoredNode = {
        runId: input.runId,
        name: input.name,
        kind: input.kind as WorkflowNodeKind,
        status: 'pending',
        attemptCount: 0,
        version: 1,
        createdAt: date,
        updatedAt: date,
      }
      nodes.set(key, node)
      return node
    },
    async setNodeInput({ runId, nodeName, input }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) throw new Error(`Missing node [${runId}.${nodeName}]`)
      const updated: StoredNode = {
        ...node,
        input,
        status: 'running',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async createAttempt(input: CreateAttemptInput) {
      const key = nodeKey(input.runId, input.nodeName)
      const node = nodes.get(key)
      if (!node) throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)
      const attempt: StoredAttempt = {
        id: ids('attempt'),
        runId: input.runId,
        nodeName: input.nodeName,
        status: 'started',
        leaseToken: ids('attempt-lease'),
        attemptNumber: node.attemptCount + 1,
        input: input.input,
        dispatchedAt: now(),
      }
      attempts.set(attempt.id, attempt)
      nodes.set(key, {
        ...node,
        status: 'running',
        currentAttemptId: attempt.id,
        attemptCount: node.attemptCount + 1,
        version: node.version + 1,
        updatedAt: now(),
      })
      return attempt
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const attempt = attempts.get(attemptId)
      if (!attempt || attempt.leaseToken !== leaseToken) return undefined
      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (!node || node.currentAttemptId !== attemptId) return undefined
      const updated = {
        ...attempt,
        status: 'completed' as const,
        output,
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      return updated
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const attempt = attempts.get(attemptId)
      if (!attempt || attempt.leaseToken !== leaseToken) return undefined
      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (!node || node.currentAttemptId !== attemptId) return undefined
      const updated = {
        ...attempt,
        status: 'failed' as const,
        error: { message: String(error) },
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      return updated
    },
    async completeNode({ runId, nodeName, output }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      const updated = {
        ...node,
        status: 'completed' as const,
        output,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async failNode({ runId, nodeName, error }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      const updated = {
        ...node,
        status: 'failed' as const,
        error: { message: String(error) },
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async completeRun({ runId, output }) {
      const run = runs.get(runId)
      if (!run) return undefined
      const updated = {
        ...run,
        status: 'completed' as const,
        output,
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async failRun({ runId, error }) {
      const run = runs.get(runId)
      if (!run) return undefined
      const updated = {
        ...run,
        status: 'failed' as const,
        error: { message: String(error) },
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
  }

  const runCoordinationExecutor: RunCoordinationExecutor = {
    async enqueue(command) {
      continueQueue.push({ id: ids('continue'), payload: command })
    },
    async enqueueDelayed(command, runAt) {
      continueQueue.push({ id: ids('continue'), payload: command, runAt })
    },
    async claim(worker) {
      const index = continueQueue.findIndex((item) =>
        worker.workflowNames.includes(item.payload.workflowName),
      )
      if (index === -1) return null
      const [item] = continueQueue.splice(index, 1)
      return {
        id: item!.id,
        command: item!.payload,
        leaseToken: ids('continue-lease'),
      }
    },
    async ack() {},
    async release(command) {
      continueQueue.push({
        id: command.id,
        payload: command.command,
      })
    },
  }

  const attemptExecutor: AttemptExecutor = {
    async dispatchActivity(command) {
      activityQueue.push({ id: ids('activity-command'), payload: command })
    },
    async dispatchTask(command) {
      taskQueue.push({ id: ids('task-command'), payload: command })
    },
    async claimActivity(worker) {
      const index = activityQueue.findIndex((item) =>
        worker.workflowNames.includes(item.payload.workflowName),
      )
      if (index === -1) return null
      const [item] = activityQueue.splice(index, 1)
      return {
        id: item!.id,
        command: item!.payload,
        leaseToken: item!.payload.leaseToken,
      }
    },
    async claimTask(worker) {
      const index = taskQueue.findIndex((item) =>
        worker.taskNames.includes(item.payload.taskName),
      )
      if (index === -1) return null
      const [item] = taskQueue.splice(index, 1)
      return {
        id: item!.id,
        command: item!.payload,
        leaseToken: item!.payload.leaseToken,
      }
    },
    async heartbeat() {},
    async ack() {},
    async release(attempt) {
      if (attempt.command.kind === 'activityAttempt') {
        activityQueue.push({ id: attempt.id, payload: attempt.command })
      } else {
        taskQueue.push({ id: attempt.id, payload: attempt.command })
      }
    },
  }

  return {
    store,
    runCoordinationExecutor,
    attemptExecutor,
    inspect: () => ({
      runs: [...runs.values()],
      nodes: [...nodes.values()],
      attempts: [...attempts.values()],
      continueRunCommands: [...continueQueue],
      activityCommands: [...activityQueue],
    }),
  }
}
```

Create `packages/workflows/src/testing/index.ts`:

```ts
export { createInMemoryWorkflowRuntime } from './in-memory-runtime.ts'
export type { InMemoryWorkflowRuntime } from './in-memory-runtime.ts'
```

- [ ] **Step 4: Add testing subpath export**

Modify `packages/workflows/package.json` exports:

```json
"./testing": {
  "types": "./src/testing/index.ts",
  "import": "./dist/testing/index.js",
  "module-sync": "./dist/testing/index.js"
}
```

Add the same `./testing` entry under `publishConfig.exports`, but with
`"types": "./dist/testing/index.d.ts"`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-store.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/testing packages/workflows/package.json packages/workflows/tests/runtime-store.spec.ts
git commit -m "feat: add in-memory workflow runtime store"
```

---

### Task 3: Runtime Registry And Routeability

**Files:**
- Create: `packages/workflows/src/runtime/registry.ts`
- Modify: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/tests/runtime-interfaces.spec.ts`

- [ ] **Step 1: Add failing routeability test**

Append to `packages/workflows/tests/runtime-interfaces.spec.ts`:

```ts
import { t } from '@nmtjs/type'

import { defineTask, defineWorkflow, implementTask, implementWorkflow } from '../src/index.ts'
import { createWorkflowRuntimeRegistry } from '../src/index.ts'

describe('workflow runtime registry', () => {
  it('registers implementations and checks routeability by declaration name', () => {
    const task = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const child = defineWorkflow({
      name: 'child',
      input: t.object({ text: t.string() }),
      output: t.object({ ok: t.boolean() }),
    }).build()
    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ ok: t.boolean() }),
    })
      .task('embedding', task)
      .workflow('child', child)
      .build()

    const taskImpl = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const childImpl = implementWorkflow(child).finish(() => ({ ok: true }))
    const parentImpl = implementWorkflow(parent)
      .embedding(task)
      .child(child)
      .finish(() => ({ ok: true }))

    const registry = createWorkflowRuntimeRegistry({
      workflows: [parentImpl, childImpl],
      tasks: [taskImpl],
    })

    expect(registry.getWorkflow('parent')).toBe(parentImpl)
    expect(registry.getTask('embedding.generate')).toBe(taskImpl)
    expect(registry.validateRouteability(parentImpl)).toStrictEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify missing registry**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-interfaces.spec.ts --reporter=agent
```

Expected: FAIL because `createWorkflowRuntimeRegistry` is not exported.

- [ ] **Step 3: Implement registry**

Create `packages/workflows/src/runtime/registry.ts`:

```ts
import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'

export type WorkflowRuntimeRegistry = {
  readonly workflows: ReadonlyMap<string, WorkflowImplementation>
  readonly tasks: ReadonlyMap<string, TaskImplementation>
  getWorkflow(name: string): WorkflowImplementation | undefined
  getTask(name: string): TaskImplementation | undefined
  validateRouteability(workflow: WorkflowImplementation): readonly string[]
}

export function createWorkflowRuntimeRegistry(input: {
  readonly workflows?: readonly WorkflowImplementation[]
  readonly tasks?: readonly TaskImplementation[]
}): WorkflowRuntimeRegistry {
  const workflows = new Map(
    (input.workflows ?? []).map((impl) => [impl.workflow.name, impl] as const),
  )
  const tasks = new Map(
    (input.tasks ?? []).map((impl) => [impl.task.name, impl] as const),
  )

  const registry: WorkflowRuntimeRegistry = {
    workflows,
    tasks,
    getWorkflow: (name) => workflows.get(name),
    getTask: (name) => tasks.get(name),
    validateRouteability(workflow) {
      const missing: string[] = []

      for (const node of workflow.nodes) {
        if (node.kind === 'task' || node.kind === 'mapTask') {
          const taskName = node.target.name
          if (!tasks.has(taskName)) missing.push(`task:${taskName}`)
        }

        if (node.kind === 'workflow' || node.kind === 'mapWorkflow') {
          const workflowName = node.target.name
          if (!workflows.has(workflowName)) {
            missing.push(`workflow:${workflowName}`)
          }
        }

        if (node.kind === 'branch' || node.kind === 'parallel') {
          for (const implementation of Object.values(node.cases)) {
            if (implementation.kind === 'task') {
              const taskName = implementation.target.name
              if (!tasks.has(taskName)) missing.push(`task:${taskName}`)
            }
            if (implementation.kind === 'workflow') {
              const workflowName = implementation.target.name
              if (!workflows.has(workflowName)) {
                missing.push(`workflow:${workflowName}`)
              }
            }
          }
        }
      }

      return Object.freeze([...new Set(missing)])
    },
  }

  return Object.freeze(registry)
}
```

- [ ] **Step 4: Export registry**

Modify `packages/workflows/src/runtime/index.ts`:

```ts
export { createWorkflowRuntimeRegistry } from './registry.ts'
export type { WorkflowRuntimeRegistry } from './registry.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export { createWorkflowRuntimeRegistry } from './runtime/index.ts'
export type { WorkflowRuntimeRegistry } from './runtime/index.ts'
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-interfaces.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-interfaces.spec.ts
git commit -m "feat: add workflow runtime registry"
```

---

### Task 4: Continuation Coordinator For Activity Nodes

**Files:**
- Create: `packages/workflows/src/runtime/coordinator.ts`
- Modify: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Write failing activity continuation test**

Create `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  continueWorkflowRun,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import { createInMemoryWorkflowRuntime } from '../src/testing/index.ts'

describe('workflow runtime coordinator', () => {
  it('dispatches an activity attempt, stores node input, and completes run after continuation', async () => {
    const workflow = defineWorkflow({
      name: 'case-generation',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: { kind: 'continueRun', runId: run.id, workflowName: workflow.name },
    })

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.activityCommands).toHaveLength(1)
    expect(afterDispatch.nodes[0]?.input).toStrictEqual({ scenario: 'alpha' })

    const attempt = afterDispatch.attempts[0]!
    await runtime.store.completeCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      output: { text: 'alpha' },
    })
    await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: { kind: 'continueRun', runId: run.id, workflowName: workflow.name },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toStrictEqual({ caseId: 'alpha' })
  })
})
```

- [ ] **Step 2: Run test to verify missing coordinator**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: FAIL because `continueWorkflowRun` is missing.

- [ ] **Step 3: Implement minimal coordinator for linear activity nodes**

Create `packages/workflows/src/runtime/coordinator.ts`:

```ts
import type { DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { ContinueRunCommand } from './commands.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import type { WorkflowStore } from './store.ts'

export type ContinueWorkflowRunInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly workflows: readonly WorkflowImplementation[]
  readonly workerId: string
  readonly command: ContinueRunCommand
  readonly leaseMs?: number
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<void> {
  const registry = createWorkflowRuntimeRegistry({ workflows: input.workflows })
  const implementation = registry.getWorkflow(input.command.workflowName)
  if (!implementation) return

  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? 30_000,
  })
  if (!lease) return

  try {
    const snapshot = await input.store.loadRunSnapshot(input.command.runId)
    if (!snapshot || isTerminalRunStatus(snapshot.run.status)) return

    const outputs = Object.fromEntries(
      snapshot.nodes
        .filter((node) => node.status === 'completed')
        .map((node) => [node.name, node.output]),
    )

    const nextNode = implementation.nodes.find(
      (node) => !snapshot.nodes.some(
        (stored) => stored.name === node.name && stored.status === 'completed',
      ),
    )

    if (!nextNode) {
      const output = await implementation.finish(
        implementation.dependencies as DependencyContext<any>,
        outputs,
        snapshot.run.input,
      )
      await input.store.completeRun({ runId: snapshot.run.id, output })
      return
    }

    if (nextNode.kind !== 'activity') {
      throw new Error(`Unsupported runtime node kind [${nextNode.kind}]`)
    }

    await dispatchActivityNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      workflow: implementation,
      runId: snapshot.run.id,
      workflowInput: snapshot.run.input,
      outputs,
      node: nextNode,
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

async function dispatchActivityNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly workflow: WorkflowImplementation
  readonly runId: string
  readonly workflowInput: unknown
  readonly outputs: Record<string, unknown>
  readonly node: ActivityNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.runId,
    name: input.node.name,
    kind: 'activity',
  })
  if (existing.status === 'running' || existing.status === 'waiting') return

  const nodeInput = input.node.input
    ? input.node.input(
        input.workflow.dependencies,
        input.outputs,
        input.workflowInput,
      )
    : input.workflowInput

  await input.store.setNodeInput({
    runId: input.runId,
    nodeName: input.node.name,
    input: nodeInput,
  })
  const attempt = await input.store.createAttempt({
    runId: input.runId,
    nodeName: input.node.name,
    input: nodeInput,
  })
  await input.attemptExecutor.dispatchActivity({
    kind: 'activityAttempt',
    workflowName: input.workflow.workflow.name,
    activityName: input.node.name,
    runId: input.runId,
    nodeName: input.node.name,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken!,
    input: nodeInput,
  })
}
```

- [ ] **Step 4: Export coordinator**

Modify `packages/workflows/src/runtime/index.ts`:

```ts
export { continueWorkflowRun } from './coordinator.ts'
export type { ContinueWorkflowRunInput } from './coordinator.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export { continueWorkflowRun } from './runtime/index.ts'
export type { ContinueWorkflowRunInput } from './runtime/index.ts'
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: coordinate workflow activity nodes"
```

---

### Task 5: Attempt Worker Completion Path

**Files:**
- Modify: `packages/workflows/src/runtime/worker.ts`
- Modify: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add failing activity worker test**

Append to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
import { runActivityAttempt } from '../src/index.ts'

it('runs claimed activity attempts and enqueues continuation on completion', async () => {
  const workflow = defineWorkflow({
    name: 'case-generation-worker',
    input: t.object({ scenario: t.string() }),
    output: t.object({ caseId: t.string() }),
  })
    .activity('content', {
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    .build()

  const implementation = implementWorkflow(workflow)
    .content(async (_ctx, input) => ({ text: input.scenario.toUpperCase() }))
    .finish((_ctx, { content }) => ({ caseId: content.text }))

  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { scenario: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    workflows: [implementation],
    workerId: 'coordinator-1',
    command: { kind: 'continueRun', runId: run.id, workflowName: workflow.name },
  })

  const claimed = await runtime.attemptExecutor.claimActivity({
    workerId: 'activity-worker-1',
    workflowNames: [workflow.name],
    leaseMs: 30_000,
  })

  await runActivityAttempt({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    workflows: [implementation],
    workerId: 'activity-worker-1',
    claimed: claimed!,
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.nodes[0]?.status).toBe('completed')
  expect(snapshot?.nodes[0]?.output).toStrictEqual({ text: 'ALPHA' })
  expect(runtime.inspect().continueRunCommands).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify missing worker helper**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: FAIL because `runActivityAttempt` is missing.

- [ ] **Step 3: Implement activity attempt runner**

Create `packages/workflows/src/runtime/worker.ts`:

```ts
import type { DependencyContext } from '@nmtjs/core'

import type { WorkflowImplementation } from '../implement/index.ts'
import type { ClaimedAttempt } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import type { WorkflowStore } from './store.ts'

export type RunActivityAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly workflows: readonly WorkflowImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
}

export async function runActivityAttempt(
  input: RunActivityAttemptInput,
): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'activityAttempt') {
    throw new Error(`Expected activity attempt, received [${command.kind}]`)
  }

  const registry = createWorkflowRuntimeRegistry({ workflows: input.workflows })
  const workflow = registry.getWorkflow(command.workflowName)
  const node = workflow?.nodes.find(
    (candidate) =>
      candidate.kind === 'activity' && candidate.name === command.nodeName,
  )
  if (!workflow || !node || node.kind !== 'activity') {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  try {
    const output = await node.activity.handler(
      node.activity.dependencies as DependencyContext<any>,
      command.input,
    )
    const attempt = await input.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: input.claimed.leaseToken,
      output,
    })
    if (attempt) {
      await input.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: command.runId,
        workflowName: command.workflowName,
      })
    }
    await input.attemptExecutor.ack(input.claimed)
  } catch (error) {
    await input.store.failCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: input.claimed.leaseToken,
      error,
    })
    await input.store.failNode({
      runId: command.runId,
      nodeName: command.nodeName,
      error,
    })
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: command.runId,
      workflowName: command.workflowName,
    })
    await input.attemptExecutor.ack(input.claimed)
  }
}
```

- [ ] **Step 4: Export worker helper**

Modify `packages/workflows/src/runtime/index.ts`:

```ts
export { runActivityAttempt } from './worker.ts'
export type { RunActivityAttemptInput } from './worker.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export { runActivityAttempt } from './runtime/index.ts'
export type { RunActivityAttemptInput } from './runtime/index.ts'
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: run workflow activity attempts"
```

---

### Task 6: Task Nodes And Task Attempt Runner

**Files:**
- Modify: `packages/workflows/src/runtime/coordinator.ts`
- Modify: `packages/workflows/src/runtime/worker.ts`
- Modify: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/tests/runtime-coordinator.spec.ts`

- [ ] **Step 1: Add failing task node test**

Append to `packages/workflows/tests/runtime-coordinator.spec.ts`:

```ts
import { defineTask, implementTask, runTaskAttempt } from '../src/index.ts'

it('dispatches task nodes to task attempts and resumes parent run', async () => {
  const task = defineTask({
    name: 'embedding.generate',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })
  const workflow = defineWorkflow({
    name: 'task-parent',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })
    .task('embedding', task)
    .build()

  const taskImpl = implementTask(task, {
    handler: async (_ctx, input) => ({ id: `emb:${input.text}` }),
  })
  const workflowImpl = implementWorkflow(workflow)
    .embedding(task, {
      input: (_ctx, _outputs, input) => ({ text: input.text }),
    })
    .finish((_ctx, { embedding }) => ({ id: embedding.id }))

  const runtime = createInMemoryWorkflowRuntime()
  const run = await runtime.store.createRun({
    workflowName: workflow.name,
    input: { text: 'alpha' },
  })

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    workflows: [workflowImpl],
    workerId: 'coordinator-1',
    command: { kind: 'continueRun', runId: run.id, workflowName: workflow.name },
  })

  const claimed = await runtime.attemptExecutor.claimTask({
    workerId: 'task-worker-1',
    taskNames: [task.name],
    leaseMs: 30_000,
  })
  await runTaskAttempt({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    tasks: [taskImpl],
    workerId: 'task-worker-1',
    claimed: claimed!,
  })

  expect(runtime.inspect().continueRunCommands).toHaveLength(1)

  await continueWorkflowRun({
    store: runtime.store,
    runCoordinationExecutor: runtime.runCoordinationExecutor,
    attemptExecutor: runtime.attemptExecutor,
    workflows: [workflowImpl],
    workerId: 'coordinator-1',
    command: { kind: 'continueRun', runId: run.id, workflowName: workflow.name },
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('completed')
  expect(snapshot?.run.output).toStrictEqual({ id: 'emb:alpha' })
})
```

- [ ] **Step 2: Run test to verify missing task runtime**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
```

Expected: FAIL on unsupported runtime node kind `task` or missing `runTaskAttempt`.

- [ ] **Step 3: Extend coordinator task dispatch**

Modify `packages/workflows/src/runtime/coordinator.ts`:

```ts
// Add branch near activity dispatch:
if (nextNode.kind === 'task') {
  const existing = await input.store.createNode({
    runId: snapshot.run.id,
    name: nextNode.name,
    kind: 'task',
  })
  if (existing.status === 'running' || existing.status === 'waiting') return
  const nodeInput = nextNode.input
    ? nextNode.input(implementation.dependencies, outputs, snapshot.run.input)
    : snapshot.run.input
  await input.store.setNodeInput({
    runId: snapshot.run.id,
    nodeName: nextNode.name,
    input: nodeInput,
  })
  const attempt = await input.store.createAttempt({
    runId: snapshot.run.id,
    nodeName: nextNode.name,
    input: nodeInput,
  })
  await input.attemptExecutor.dispatchTask({
    kind: 'taskAttempt',
    workflowName: implementation.workflow.name,
    taskName: nextNode.target.name,
    runId: snapshot.run.id,
    nodeName: nextNode.name,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken!,
    input: nodeInput,
  })
  return
}
```

Replace the previous unsupported-node throw with:

```ts
throw new Error(`Unsupported runtime node kind [${nextNode.kind}]`)
```

only after `activity` and `task` branches.

- [ ] **Step 4: Implement task attempt runner**

Modify `packages/workflows/src/runtime/worker.ts`:

```ts
import type { TaskImplementation } from '../implement/index.ts'

export type RunTaskAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly tasks: readonly TaskImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
}

export async function runTaskAttempt(input: RunTaskAttemptInput): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Expected task attempt, received [${command.kind}]`)
  }

  const task = input.tasks.find((candidate) => candidate.task.name === command.taskName)
  if (!task) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  try {
    const output = await task.handler(task.dependencies as DependencyContext<any>, command.input)
    const attempt = await input.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: input.claimed.leaseToken,
      output,
    })
    if (attempt) {
      await input.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: command.runId,
        workflowName: command.workflowName,
      })
    }
    await input.attemptExecutor.ack(input.claimed)
  } catch (error) {
    await input.store.failCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: input.claimed.leaseToken,
      error,
    })
    await input.store.failNode({
      runId: command.runId,
      nodeName: command.nodeName,
      error,
    })
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: command.runId,
      workflowName: command.workflowName,
    })
    await input.attemptExecutor.ack(input.claimed)
  }
}
```

- [ ] **Step 5: Export task runner and run tests**

Modify `packages/workflows/src/runtime/index.ts`:

```ts
export { runTaskAttempt } from './worker.ts'
export type { RunTaskAttemptInput } from './worker.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export { runTaskAttempt } from './runtime/index.ts'
export type { RunTaskAttemptInput } from './runtime/index.ts'
```

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-coordinator.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-coordinator.spec.ts
git commit -m "feat: coordinate workflow task nodes"
```

---

### Task 7: Worker Concurrency Wrapper

**Files:**
- Modify: `packages/workflows/src/runtime/worker.ts`
- Test: `packages/workflows/tests/runtime-worker.spec.ts`

- [ ] **Step 1: Write failing concurrency test**

Create `packages/workflows/tests/runtime-worker.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { runWithConcurrency } from '../src/index.ts'

describe('workflow worker concurrency', () => {
  it('limits simultaneous slots while draining work', async () => {
    let active = 0
    let maxActive = 0
    const items = [1, 2, 3, 4, 5]

    await runWithConcurrency(items, 2, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    expect(maxActive).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify missing helper**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-worker.spec.ts --reporter=agent
```

Expected: FAIL because `runWithConcurrency` is missing.

- [ ] **Step 3: Implement small concurrency helper**

Modify `packages/workflows/src/runtime/worker.ts`:

```ts
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Concurrency must be a positive integer`)
  }

  let nextIndex = 0
  const slots = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++]!
        await worker(item)
      }
    },
  )

  await Promise.all(slots)
}
```

- [ ] **Step 4: Export helper**

Modify `packages/workflows/src/runtime/index.ts`:

```ts
export { runWithConcurrency } from './worker.ts'
```

Modify `packages/workflows/src/index.ts`:

```ts
export { runWithConcurrency } from './runtime/index.ts'
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run tests/runtime-worker.spec.ts --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

Commit:

```bash
git add packages/workflows/src/runtime packages/workflows/src/index.ts packages/workflows/tests/runtime-worker.spec.ts
git commit -m "feat: add workflow worker concurrency helper"
```

---

### Task 8: Package Export Boundaries And Full Verification

**Files:**
- Modify: `packages/workflows/package.json`
- Modify: `packages/workflows/src/runtime/index.ts`
- Test: existing workflow test suite

- [ ] **Step 1: Add runtime subpath exports**

Modify `packages/workflows/package.json` root `exports`:

```json
"./runtime": {
  "types": "./src/runtime/index.ts",
  "import": "./dist/runtime/index.js",
  "module-sync": "./dist/runtime/index.js"
}
```

Add matching `publishConfig.exports["./runtime"]`:

```json
"./runtime": {
  "types": "./dist/runtime/index.d.ts",
  "import": "./dist/runtime/index.js",
  "module-sync": "./dist/runtime/index.js"
}
```

- [ ] **Step 2: Verify no adapter dependencies entered package**

Run:

```bash
rg -n '"bullmq"|"ioredis"|"iovalkey"|"pg"|"postgres"' packages/workflows/package.json packages/workflows/src
```

Expected: no matches.

- [ ] **Step 3: Run package tests**

Run:

```bash
pnpm --filter @nmtjs/workflows vitest run --reporter=agent
pnpm --filter @nmtjs/workflows exec tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 4: Run repo lint**

Run:

```bash
pnpm oxlint . --format=agent
```

Expected: PASS or only unrelated pre-existing issues. If there are failures in files touched by this plan, fix them before commit.

- [ ] **Step 5: Commit final export boundary**

Commit:

```bash
git add packages/workflows/package.json packages/workflows/src/runtime packages/workflows/src/testing packages/workflows/src/index.ts packages/workflows/tests
git commit -m "feat: expose workflow runtime core"
```

---

## Self-Review

Spec coverage:

- Store-owned state machine: Tasks 1 and 2 define and test semantic state/store.
- `RunCoordinationExecutor` and `AttemptExecutor` split: Task 1 defines interfaces, Task 2 implements in-memory versions.
- `continueRun` coordinator: Task 4 implements first coordinator path.
- Attempts and stale completion: Task 2 tests stale attempt rejection.
- Activity/task attempt execution: Tasks 5 and 6 implement runners.
- Concurrency: Task 7 adds bounded concurrency helper.
- Worker routeability: Task 3 implements registry checks.
- Adapter-free boundary: Task 8 verifies no BullMQ/Redis/Postgres dependencies.

Out-of-scope for this first implementation slice:

- Child workflow, branch, parallel, `mapTask`, and `mapWorkflow` execution.
- Retry delay, cancellation propagation, child links, and map item snapshots are typed in the spec but not fully implemented here.
- Production worker loops that poll indefinitely. This plan only adds a bounded concurrency helper and direct runner functions.

Task attempt completion does enqueue parent continuation because `TaskAttemptCommand`
includes parent `workflowName`.
