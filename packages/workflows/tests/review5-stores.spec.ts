import { randomUUID } from 'node:crypto'

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/adapters/in-memory.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

const createPostgresHarness = async () => {
  const db = new PGlite()
  const connection = createPostgresWorkflowConnection(db)
  await installPostgresWorkflowSchemaForTesting(connection)
  return { db, store: createPostgresWorkflowRuntime({ connection }).store }
}

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

describe('in-memory root inheritance', () => {
  test('still roots a run in itself when its parent does not exist', async () => {
    const { store } = createInMemoryWorkflowRuntime()

    const orphan = await store.createRun({
      workflowName: 'orphan',
      input: {},
      parentRunId: 'missing-parent',
    })

    expect(orphan).toMatchObject({
      parentRunId: 'missing-parent',
      rootRunId: orphan.id,
    })
  })
})
