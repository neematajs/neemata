import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createWorkflowRuntimeRegistry,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'

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

  it('routes workflow and task implementations by contract name', () => {
    const task = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })

    const child = defineWorkflow({
      name: 'child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()

    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .workflow('child', child)
      .build()

    const taskImpl = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const childImpl = implementWorkflow(child).finish((_ctx, _outputs, input) => ({
      text: input.text,
    }))
    const parentImpl = implementWorkflow(parent)
      .embedding(task, { input: (_ctx, _outputs, input) => input })
      .child(child, { input: (_ctx, { embedding }) => ({ text: embedding.id }) })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))

    const registry = createWorkflowRuntimeRegistry({
      workflows: [parentImpl, childImpl],
      tasks: [taskImpl],
    })

    expect(registry.getWorkflow('parent')).toBe(parentImpl)
    expect(registry.getTask('embedding.generate')).toBe(taskImpl)
    expect(registry.validateRouteability(parentImpl)).toStrictEqual([])
  })
})
