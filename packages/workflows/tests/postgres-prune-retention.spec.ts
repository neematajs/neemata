import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

async function createRuntime() {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection })
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
      olderThan: new Date(Date.now() + 1_000),
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
      olderThan: new Date(Date.now() + 1_000),
    }),
  ).resolves.toStrictEqual({ deleted: 1 })
  await expect(runtime.store.loadRunSnapshot(root.id)).resolves.toBeUndefined()
  await expect(
    runtime.store.loadRunSnapshot(childRun.id),
  ).resolves.toBeUndefined()
})
