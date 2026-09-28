import { randomUUID } from 'node:crypto'

import { PGlite } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { describe, expect, test, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
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

async function seedReapedCommands(
  connection: WorkflowPostgresConnection,
  runId: string,
  count: number,
) {
  const ids = Array.from({ length: count }, () => randomUUID()).sort()
  await connection.query(
    `INSERT INTO workflow_commands (id, kind, run_id, dead_at, reaped_at)
     SELECT id, 'activity', $1, '2020-01-01', '2020-01-01'
     FROM unnest($2::uuid[]) AS id`,
    [runId, ids],
  )
  return ids
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
  ).resolves.toStrictEqual({ deleted: 0, hasMore: false })
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
  ).resolves.toStrictEqual({ deleted: 1, hasMore: false })
  await expect(runtime.store.loadRunSnapshot(root.id)).resolves.toBeUndefined()
  await expect(
    runtime.store.loadRunSnapshot(childRun.id),
  ).resolves.toBeUndefined()
})

describe('retention with unreaped dead commands', () => {
  test('bounds each dead-command sweep and keeps unreaped, recent, and live commands', async () => {
    const { db, connection, store } = await createPostgresHarness()
    try {
      const run = await store.createRun({
        workflowName: 'dead-backlog',
        input: {},
      })
      const old = '2020-01-01T00:00:00Z'
      const cutoff = '2020-01-02T00:00:00Z'
      const eligible = [randomUUID(), randomUUID(), randomUUID()].sort()
      const protectedIds = [randomUUID(), randomUUID(), randomUUID()]
      const records = [
        ...eligible.map((id) => ({ id, deadAt: old, reapedAt: old })),
        { id: protectedIds[0], deadAt: old, reapedAt: null },
        { id: protectedIds[1], deadAt: cutoff, reapedAt: cutoff },
        { id: protectedIds[2], deadAt: null, reapedAt: null },
      ]
      for (const record of records) {
        await connection.query(
          `INSERT INTO workflow_commands (id, kind, run_id, dead_at, reaped_at)
           VALUES ($1, 'activity', $2, $3, $4)`,
          [record.id, run.id, record.deadAt, record.reapedAt],
        )
      }
      async function remaining() {
        const { rows } = await connection.query<{ id: string }>(
          'SELECT id FROM workflow_commands ORDER BY id',
        )
        return rows.map(({ id }) => id)
      }
      const params = { olderThan: Date.parse(cutoff), statuses: [] }

      await expect(
        store.pruneTerminalRuns({ ...params, batchSize: 2 }),
      ).resolves.toStrictEqual({ deleted: 0, hasMore: true })
      expect(await remaining()).toEqual([eligible[2], ...protectedIds].sort())
      await expect(
        store.pruneTerminalRuns({ ...params, batchSize: 2 }),
      ).resolves.toStrictEqual({ deleted: 0, hasMore: false })
      expect(await remaining()).toEqual(protectedIds.sort())
      await expect(store.loadRunSnapshot(run.id)).resolves.toBeDefined()
    } finally {
      await db.close()
    }
  })

  test('rejects invalid batch sizes before opening a PostgreSQL transaction', async () => {
    const { db, connection, runtime, store } = await createPostgresHarness()
    const transaction = vi.spyOn(connection, 'transaction')
    try {
      for (const batchSize of [
        -1,
        1.5,
        Number.NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const params = { olderThan: Date.now(), batchSize }
        await expect(store.pruneTerminalRuns(params)).rejects.toThrow(
          RangeError,
        )
        await expect(
          runtime.retentionPruner!.pruneTerminalRuns(params),
        ).rejects.toThrow(RangeError)
      }
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      transaction.mockRestore()
      await db.close()
    }
  })

  test('bounds dead-command cleanup when a zero batch size disables root pruning', async () => {
    const { db, connection, store } = await createPostgresHarness()
    try {
      const run = await store.createRun({
        workflowName: 'disabled-root-pruning',
        input: {},
      })
      await store.completeRun({ runId: run.id, output: {} })
      const olderThan = Date.now() + 1_000
      const batchSize = 0
      const commandIds = await seedReapedCommands(connection, run.id, 101)

      await expect(
        store.pruneTerminalRuns({ olderThan, batchSize }),
      ).resolves.toStrictEqual({ deleted: 0, hasMore: true })
      const { rows } = await connection.query<{ id: string }>(
        'SELECT id FROM workflow_commands ORDER BY id',
      )
      expect(rows).toStrictEqual([{ id: commandIds[100] }])
      await expect(store.loadRunSnapshot(run.id)).resolves.toBeDefined()

      await expect(
        store.pruneTerminalRuns({ olderThan, batchSize }),
      ).resolves.toStrictEqual({ deleted: 0, hasMore: false })
      await expect(store.listDeadCommands()).resolves.toStrictEqual([])
    } finally {
      await db.close()
    }
  })

  test.each([
    { label: 'default batch size', params: {} },
    { label: 'small batch size', params: { batchSize: 2 } },
    { label: 'empty statuses', params: { statuses: [] } },
    { label: 'zero batch size', params: { batchSize: 0 } },
  ])(
    'client drains the command backlog with $label and no old terminal runs',
    async ({ params }) => {
      const { db, connection, runtime, store } = await createPostgresHarness()
      try {
        const run = await store.createRun({
          workflowName: 'client-prune',
          input: {},
        })
        await seedReapedCommands(connection, run.id, 201)
        const client = createWorkflowRuntimeClient(runtime)

        await expect(
          client.pruneRuns({ olderThan: Date.now(), ...params }),
        ).resolves.toStrictEqual({ deleted: 0 })
        await expect(store.listDeadCommands()).resolves.toStrictEqual([])
        await expect(store.loadRunSnapshot(run.id)).resolves.toBeDefined()
      } finally {
        await db.close()
      }
    },
  )

  test.each([
    { roots: 3, commands: 7 },
    { roots: 7, commands: 3 },
  ])(
    'client drains $roots roots and $commands dead commands when one backlog finishes first',
    async ({ roots, commands }) => {
      const { db, connection, runtime, store } = await createPostgresHarness()
      try {
        const active = await store.createRun({
          workflowName: 'active',
          input: {},
        })
        await seedReapedCommands(connection, active.id, commands)
        for (let index = 0; index < roots; index++) {
          const root = await store.createRun({
            workflowName: 'terminal',
            input: {},
          })
          await store.completeRun({ runId: root.id, output: {} })
        }
        const client = createWorkflowRuntimeClient(runtime)

        await expect(
          client.pruneRuns({ olderThan: Date.now() + 1_000, batchSize: 2 }),
        ).resolves.toStrictEqual({ deleted: roots })
        await expect(store.listDeadCommands()).resolves.toStrictEqual([])
        await expect(
          store.listRuns({ name: 'terminal' }),
        ).resolves.toStrictEqual({ runs: [] })
        await expect(store.loadRunSnapshot(active.id)).resolves.toBeDefined()
      } finally {
        await db.close()
      }
    },
  )

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
        workflows: [],
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
    ).resolves.toStrictEqual({ deleted: 0, hasMore: false })
    await expect(
      store.loadRuns([root.id, child.id, grandchild.id]),
    ).resolves.toHaveLength(3)
    await expect(store.deleteRun(root.id)).rejects.toThrow(
      `Run [${root.id}] has non-terminal runs`,
    )

    await store.completeRun({ runId: grandchild.id, output: null })

    await expect(
      store.pruneTerminalRuns({ olderThan: Date.now() + 1_000 }),
    ).resolves.toStrictEqual({ deleted: 1, hasMore: false })
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
