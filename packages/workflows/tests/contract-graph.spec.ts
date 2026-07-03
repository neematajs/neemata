import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTask, defineWorkflow } from '../src/index.ts'

describe('workflow contract graph', () => {
  const embedding = defineTask({
    name: 'embedding.generate',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })

  const fallbackWorkflow = defineWorkflow({
    name: 'fallback-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const numberTask = defineTask({
    name: 'number-task',
    input: t.object({ text: t.string() }),
    output: t.object({ count: t.number() }),
  })
  const numberWorkflow = defineWorkflow({
    name: 'number-workflow',
    input: t.object({ text: t.string() }),
    output: t.object({ count: t.number() }),
  }).build()

  const workflow = defineWorkflow({
    name: 'case-generation',
    input: t.object({
      kind: t.union(t.literal('normal'), t.literal('fallback')),
      scenario: t.string(),
    }),
    output: t.object({ caseId: t.string() }),
  })
    .activity('content', {
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    .task('embedding', embedding)
    .workflow('fallbackContent', fallbackWorkflow)
    .branch('caseContent', {
      output: t.object({ text: t.string() }),
      cases: (helpers) => ({
        normal: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        fallback: helpers.workflow(fallbackWorkflow),
      }),
    })
    .build()

  it('preserves introspectable node metadata', () => {
    const [activityNode, taskNode, childWorkflowNode, branchNode] =
      workflow.nodes

    expect(activityNode.output).toBeDefined()
    expect(taskNode.task).toBe(embedding)
    expect(childWorkflowNode.workflow).toBe(fallbackWorkflow)
    expect(branchNode.output).toBeDefined()
    expect(branchNode.cases.normal.kind).toBe('activity')
    expect(branchNode.cases.fallback.target).toBe(fallbackWorkflow)

    expectTypeOf(taskNode.task).toEqualTypeOf<typeof embedding>()
    expectTypeOf(childWorkflowNode.workflow).toEqualTypeOf<
      typeof fallbackWorkflow
    >()
    expectTypeOf(branchNode.cases.fallback.target).toEqualTypeOf<
      typeof fallbackWorkflow
    >()
  })

  it('rejects converged branch task and workflow cases with mismatched outputs', () => {
    defineWorkflow({
      name: 'invalid-converged-branch',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          // @ts-expect-error task output must match declared branch output
          task: helpers.task(numberTask),
          // @ts-expect-error workflow output must match declared branch output
          workflow: helpers.workflow(numberWorkflow),
        }),
      })
      .build()
  })
})
