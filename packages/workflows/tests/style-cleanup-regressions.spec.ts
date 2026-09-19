import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'
import { parseDurationMs } from '../src/runtime/duration.ts'
import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'

const text = t.object({ text: t.string() })

describe('workflow definition regressions', () => {
  it('accepts a never-output task as an unconstrained case', () => {
    const silent = defineTask({
      name: 'silent',
      input: text,
      output: t.never(),
    })

    const workflow = defineWorkflow({ name: 'never-case', input: text })
      .parallel('fanout', (cases) => ({ silent: cases.task(silent) }))
      .build()

    expect(workflow.nodes).toHaveLength(1)
  })

  it('accepts case implementations inherited through a prototype', () => {
    const workflow = defineWorkflow({ name: 'getter-cases', input: text })
      .branch('choose', {
        output: text,
        cases: (cases) => ({
          only: cases.activity({ input: text, output: text }),
        }),
      })
      .build()

    const implement = () =>
      implementWorkflow(workflow).choose({
        select: () => 'only' as const,
        cases: ({ activity }) => {
          const only = activity(async (_ctx, input) => input)
          // Object.create: the case lives on the prototype, not the object
          return Object.create({ only })
        },
      })

    expect(implement).not.toThrow()
  })
})

describe('workflow runtime regressions', () => {
  it('rejects a duration whose coefficient overflows', () => {
    expect(parseDurationMs(`${'9'.repeat(309)}ms`)).toBeUndefined()
  })

  it('matches no run for an invalid date cutoff', async () => {
    const { store } = createInMemoryWorkflowRuntime()
    await store.createRun({ workflowName: 'cutoff', input: {} })

    const invalid = new Date(Number.NaN)
    const page = await store.listRuns({
      activeBefore: invalid,
      createdBefore: invalid,
    })

    expect(page.runs).toStrictEqual([])
  })

  it('leaves a completed run untouched by a late unserializable failure', async () => {
    const { store } = createInMemoryWorkflowRuntime()
    const run = await store.createRun({ workflowName: 'late', input: {} })
    await store.markRunRunning({ runId: run.id })
    const completed = await store.completeRun({ runId: run.id, output: {} })

    await expect(
      store.failRun({ runId: run.id, error: Object.create(null) }),
    ).resolves.toStrictEqual(completed)
  })
})
