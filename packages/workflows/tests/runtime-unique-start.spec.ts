import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

import { defineWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  WorkflowRunConflictError,
} from '../src/runtime/index.ts'

const workflow = defineWorkflow({
  name: 'in-memory-unique-workflow',
  input: t.object({ value: t.string() }),
}).build()

function createHarness() {
  const runtime = createInMemoryWorkflowRuntime()
  const client = createWorkflowRuntimeClient(runtime)
  return { runtime, client }
}

test('active scope rejects duplicates and frees the key on terminal transition', async () => {
  const { runtime, client } = createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )

  const conflict = await client
    .start(workflow, { value: 'beta' }, { unique: { key: ['turn', 1] } })
    .then(
      () => undefined,
      (error) => error,
    )
  expect(conflict).toBeInstanceOf(WorkflowRunConflictError)
  expect(conflict.runId).toBe(first.id)

  await runtime.store.completeRun({ runId: first.id, output: undefined })

  const second = await client.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['turn', 1] } },
  )
  expect(second.id).not.toBe(first.id)
})

test('a cancelling run still holds its active key', async () => {
  const { runtime, client } = createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )
  await runtime.store.requestRunCancellation({ runId: first.id })

  await expect(
    client.start(workflow, { value: 'beta' }, { unique: { key: ['turn', 1] } }),
  ).rejects.toThrow(WorkflowRunConflictError)

  await runtime.store.cancelRun({ runId: first.id })
  const second = await client.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['turn', 1] } },
  )
  expect(second.id).not.toBe(first.id)
})

test('join returns the conflicting run regardless of input', async () => {
  const { client } = createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )
  const joined = await client.start(
    workflow,
    { value: 'different' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )
  expect(joined.id).toBe(first.id)
})

test("scope 'all' holds the key across terminal transitions", async () => {
  const { runtime, client } = createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['once', 1], scope: 'all' } },
  )
  await runtime.store.completeRun({ runId: first.id, output: undefined })

  await expect(
    client.start(
      workflow,
      { value: 'beta' },
      { unique: { key: ['once', 1], scope: 'all' } },
    ),
  ).rejects.toThrow(WorkflowRunConflictError)
})

test('deleting a run releases its unique keys', async () => {
  const { runtime, client } = createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['once', 1], scope: 'all' } },
  )
  await runtime.store.completeRun({ runId: first.id, output: undefined })
  await client.deleteRun(first.id)

  const second = await client.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['once', 1], scope: 'all' } },
  )
  expect(second.id).not.toBe(first.id)
})
