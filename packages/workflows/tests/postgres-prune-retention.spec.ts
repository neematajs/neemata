import { randomUUID } from 'node:crypto'

import { PGlite } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow } from '../src/effect/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'

async function createPostgresHarness(maxDeliveries?: number) {
  const db = new PGlite()
  const connection = createPostgresWorkflowConnection(db)
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection, maxDeliveries })
  return { db, connection, runtime, store: runtime.store }
}

async function createRuntime() {
  const { runtime } = await createPostgresHarness()
  return runtime
}

async function createRootWithChild() {
  const runtime = await createRuntime()
  const root = await runtime.store.createRun({
    workflowName: 'postgres-prune-root',
    input: {},
  })
  await runtime.store.createNode({
    runId: root.id,
    name: 'child',
    kind: 'workflow',
  })
  await runtime.store.ensureNodeChildren({
    runId: root.id,
    nodeName: 'child',
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  const { childRun } = await runtime.store.ensureChildRun({
    runId: root.id,
    nodeName: 'child',
    childKey: '$self',
    childKind: 'workflow',
    childName: 'postgres-prune-child',
    input: {},
    rootRunId: root.id,
  })

  return { runtime, root, childRun }
}

test('postgres retention pruning preserves terminal roots with live descendants', async () => {
  const { runtime, root, childRun } = await createRootWithChild()
  await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

  await expect(
    runtime.store.pruneTerminalRuns({
      olderThan: Date.now() + 1_000,
    }),
  ).resolves.toStrictEqual({ deleted: 0 })
  await expect(runtime.store.loadRunSnapshot(root.id)).resolves.toBeDefined()
  await expect(
    runtime.store.loadRunSnapshot(childRun.id),
  ).resolves.toBeDefined()
})

test('postgres retention pruning removes terminal roots after descendants finish', async () => {
  const { runtime, root, childRun } = await createRootWithChild()
  await runtime.store.completeRun({
    runId: childRun.id,
    output: { ok: true },
  })
  await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

  await expect(
    runtime.store.pruneTerminalRuns({
      olderThan: Date.now() + 1_000,
    }),
  ).resolves.toStrictEqual({ deleted: 1 })
  await expect(runtime.store.loadRunSnapshot(root.id)).resolves.toBeUndefined()
  await expect(
    runtime.store.loadRunSnapshot(childRun.id),
  ).resolves.toBeUndefined()
})

describe('retention with unreaped dead commands', () => {
  test('retention keeps an unreaped dead command so its run still settles', async () => {
    const { runtime } = await createPostgresHarness(1)
    const workflow = defineWorkflow({
      name: 'retention-dead-command',
      input: Schema.Struct({ value: Schema.String }),
    }).build()
    const run = await createWorkflowRuntimeClient(runtime).start(workflow, {
      value: 'alpha',
    })

    const claimed = await runtime.runCoordinationExecutor.claim({
      workerId: 'retention-worker',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()
    await runtime.runCoordinationExecutor.release(claimed!, {
      error: new Error('poison'),
    })
    expect(await runtime.store.listUnreapedDeadCommands()).toHaveLength(1)

    // downtime longer than the retention window: the cutoff is past dead_at
    // before any reaper has seen the command
    const olderThan = Date.now() + 60_000
    await runtime.retentionPruner!.pruneTerminalRuns({ olderThan })
    expect(await runtime.store.listUnreapedDeadCommands()).toHaveLength(1)

    await expect(
      reapDeadWorkflowCommands({
        store: runtime.store,
        attemptExecutor: runtime.attemptExecutor,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
      }),
    ).resolves.toStrictEqual({ reaped: 1 })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'failed',
    )

    // once the outcome is recorded the command is ordinary history
    await runtime.retentionPruner!.pruneTerminalRuns({
      olderThan,
      statuses: [],
    })
    expect(await runtime.store.listDeadCommands()).toHaveLength(0)
  })
})

describe('postgres pruning of families linked outside the root id', () => {
  test('follows parent links below a run rooted outside the pruned root', async () => {
    const { db, store } = await createPostgresHarness()
    const root = await store.createRun({ workflowName: 'root', input: {} })
    const child = await store.createRun({
      workflowName: 'child',
      input: {},
      parentRunId: root.id,
    })
    // The shape createRun stored before children inherited their parent's
    // root: linked by parent only, rooted in itself.
    await db.query('UPDATE workflow_runs SET root_run_id = id WHERE id = $1', [
      child.id,
    ])
    const grandchild = await store.createRun({
      workflowName: 'grandchild',
      input: {},
      parentRunId: child.id,
    })
    expect(grandchild.rootRunId).toBe(child.id)
    await store.markRunRunning({ runId: grandchild.id })
    await store.completeRun({ runId: root.id, output: null })
    await store.completeRun({ runId: child.id, output: null })

    await expect(
      store.pruneTerminalRuns({ olderThan: Date.now() + 1_000 }),
    ).resolves.toStrictEqual({ deleted: 0 })
    await expect(
      store.loadRuns([root.id, child.id, grandchild.id]),
    ).resolves.toHaveLength(3)
    await expect(store.deleteRun(root.id)).rejects.toThrow(
      `Run [${root.id}] has non-terminal runs`,
    )

    await store.completeRun({ runId: grandchild.id, output: null })

    await expect(
      store.pruneTerminalRuns({ olderThan: Date.now() + 1_000 }),
    ).resolves.toStrictEqual({ deleted: 1 })
    await expect(
      store.loadRuns([root.id, child.id, grandchild.id]),
    ).resolves.toStrictEqual([])
  })

  test('still rejects a run whose parent does not exist', async () => {
    const { store } = await createPostgresHarness()

    await expect(
      store.createRun({
        workflowName: 'orphan',
        input: {},
        parentRunId: randomUUID(),
      }),
    ).rejects.toThrow(/workflow_runs_parent_run_fk/)
  })
})
