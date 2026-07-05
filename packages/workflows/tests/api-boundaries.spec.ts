import { createValueInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as workflows from '../src/index.ts'

const { defineTask, defineWorkflow, implementTask, implementWorkflow } =
  workflows

describe('workflow API boundaries', () => {
  const prefix = createValueInjectable('prefix')

  const embedding = defineTask({
    name: 'embedding.generate',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
    idempotency: (input) => ['embedding.generate', input.text],
  })

  const childWorkflow = defineWorkflow({
    name: 'child',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()

  const workflow = defineWorkflow({
    name: 'case-generation',
    input: t.object({
      kind: t.union(t.literal('normal'), t.literal('fallback')),
      scenario: t.string(),
    }),
    output: t.object({ caseId: t.string() }),
    retention: '30d',
    idempotency: (input) => ['case-generation', input.scenario],
    tags: (input) => ({ kind: input.kind }),
  })
    .activity('content', {
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    .branch('caseContent', {
      cases: (helpers) => ({
        normal: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ kind: t.literal('normal'), text: t.string() }),
        }),
        fallback: helpers.workflow(childWorkflow),
      }),
    })
    .task('embedding', embedding)
    .activity('saveCase', {
      input: t.object({ scenario: t.string(), embeddingId: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
    .build()

  it('keeps executable callbacks out of the contract graph', () => {
    const graph = JSON.stringify(workflow)

    expect(graph).toContain('case-generation')
    expect(graph).not.toContain('select')
    expect(graph).not.toContain('items')
    expect(graph).not.toContain('idempotency')
    expect(graph).not.toContain('tags')

    for (const node of workflow.nodes) {
      expect(node).not.toHaveProperty('inputMapper')
      expect(node).not.toHaveProperty('select')
      expect(node).not.toHaveProperty('items')
      expect(node).not.toHaveProperty('idempotency')
    }
  })

  it('retains definition-owned start metadata and implementation-owned node idempotency', () => {
    const taskImpl = implementTask(embedding, {
      async handler(_ctx, input) {
        return { id: input.text }
      },
    })

    const workflowImpl = implementWorkflow(workflow, {
      dependencies: { prefix },
    })
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        idempotency: (ctx, _outputs, input) => [ctx.prefix, input.scenario],
      })
      .caseContent({
        select: (_ctx, _outputs, input) => input.kind,
        cases: ({ activity, workflow }) => ({
          normal: activity(
            async (_ctx, input) => ({
              kind: 'normal' as const,
              text: input.text,
            }),
            {
              input: (_ctx, { content }) => ({ text: content.text }),
              idempotency: (_ctx, { content }) => ['normal', content.text],
            },
          ),
          fallback: workflow(childWorkflow, {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
            idempotency: (_ctx, _outputs, input) => [
              'fallback',
              input.scenario,
            ],
          }),
        }),
      })
      .embedding(embedding, {
        input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
        idempotency: (_ctx, { caseContent }) => ['embedding', caseContent.text],
      })
      .saveCase(async (_ctx, input) => ({ caseId: input.embeddingId }), {
        input: (_ctx, { embedding }, input) => ({
          scenario: input.scenario,
          embeddingId: embedding.id,
        }),
        idempotency: (_ctx, _outputs, input) => ['save', input.scenario],
      })
      .finish((_ctx, { saveCase }) => ({ caseId: saveCase.caseId }))

    expect(embedding.idempotency).toBeTypeOf('function')
    expect(workflow.idempotency).toBeTypeOf('function')
    expect(workflow.tags).toBeTypeOf('function')
    expect(taskImpl).not.toHaveProperty('idempotency')
    expect(workflowImpl).not.toHaveProperty('idempotency')
    expect(workflowImpl).not.toHaveProperty('tags')
    const [contentNode, branchNode, embeddingNode, saveNode] =
      workflowImpl.nodes

    expect(contentNode?.kind).toBe('activity')
    if (contentNode?.kind !== 'activity') throw new Error('Expected activity')
    expect(contentNode.idempotency).toBeTypeOf('function')

    expect(branchNode?.kind).toBe('branch')
    if (branchNode?.kind !== 'branch') throw new Error('Expected branch')
    expect(branchNode.cases.normal?.idempotency).toBeTypeOf('function')

    expect(embeddingNode?.kind).toBe('task')
    if (embeddingNode?.kind !== 'task') throw new Error('Expected task')
    expect(embeddingNode.idempotency).toBeTypeOf('function')

    expect(saveNode?.kind).toBe('activity')
    if (saveNode?.kind !== 'activity') throw new Error('Expected activity')
    expect(saveNode.idempotency).toBeTypeOf('function')
  })

  it('rejects missing, extra, and mismatched runnable implementations', () => {
    const otherTask = defineTask({
      name: 'embedding.other',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })

    expect(() =>
      implementWorkflow(workflow)
        .content(async (_ctx, input) => ({ text: input.scenario }))
        .caseContent({
          select: (_ctx, _outputs, input) => input.kind,
          cases: (({ activity }) => ({
            normal: activity(async (_ctx, input) => ({
              kind: 'normal' as const,
              text: input.text,
            })),
          })) as any,
        }),
    ).toThrow(
      'Missing workflow branch case implementation [caseContent.fallback]',
    )

    expect(() =>
      implementWorkflow(workflow)
        .content(async (_ctx, input) => ({ text: input.scenario }))
        .caseContent({
          select: (_ctx, _outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity(async (_ctx, input) => ({
              kind: 'normal' as const,
              text: input.text,
            })),
            fallback: workflow(childWorkflow),
            extra: activity(async (_ctx) => ({
              kind: 'normal' as const,
              text: 'extra',
            })),
          }),
        }),
    ).toThrow('Unknown workflow branch case implementation [caseContent.extra]')

    expect(() =>
      implementWorkflow(workflow)
        .content(async (_ctx, input) => ({ text: input.scenario }))
        .caseContent({
          select: (_ctx, _outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity(async (_ctx, input) => ({
              kind: 'normal' as const,
              text: input.text,
            })),
            fallback: workflow(childWorkflow),
          }),
        })
        .embedding(otherTask as any),
    ).toThrow(
      'Workflow task implementation [embedding] does not match contract',
    )
  })

  it('separates decode input from decoded handler and output types', () => {
    const dateTask = defineTask({
      name: 'date.normalize',
      input: t.date(),
      output: t.date(),
    })
    const dateWorkflow = defineWorkflow({
      name: 'date.workflow',
      input: t.date(),
      output: t.date(),
    })
      .activity('normalize', {
        input: t.date(),
        output: t.date(),
      })
      .mapTask('dates', dateTask, {
        item: t.date(),
        mode: 'wait-all',
      })
      .build()

    expectTypeOf<workflows.TaskInput<typeof dateTask>>().toEqualTypeOf<string>()
    expectTypeOf<workflows.TaskOutput<typeof dateTask>>().toEqualTypeOf<Date>()
    expectTypeOf<
      workflows.WorkflowInput<typeof dateWorkflow>
    >().toEqualTypeOf<string>()
    expectTypeOf<
      workflows.WorkflowOutput<typeof dateWorkflow>
    >().toEqualTypeOf<Date>()
    expectTypeOf<
      workflows.WorkflowRun<typeof dateWorkflow>['input']
    >().toEqualTypeOf<Date>()
    expectTypeOf<
      workflows.WorkflowRun<typeof dateWorkflow>['output']
    >().toEqualTypeOf<Date | undefined>()

    implementTask(dateTask, {
      handler: async (_ctx, input) => {
        expectTypeOf(input).toEqualTypeOf<Date>()
        return input.toISOString()
      },
    })

    implementWorkflow(dateWorkflow)
      .normalize(
        async (_ctx, input) => {
          expectTypeOf(input).toEqualTypeOf<Date>()
          return input.toISOString()
        },
        {
          input: (_ctx, _outputs, input) => {
            expectTypeOf(input).toEqualTypeOf<Date>()
            return input.toISOString()
          },
        },
      )
      .dates(dateTask, {
        items: (_ctx, _outputs, input) => {
          expectTypeOf(input).toEqualTypeOf<Date>()
          return [input.toISOString()]
        },
        input: (_ctx, _outputs, item, input) => {
          expectTypeOf(item).toEqualTypeOf<Date>()
          expectTypeOf(input).toEqualTypeOf<Date>()
          return item.toISOString()
        },
      })
      .finish((_ctx, { normalize, dates }, input) => {
        expectTypeOf(normalize).toEqualTypeOf<Date>()
        expectTypeOf(dates.items[0]?.item).toMatchTypeOf<Date | undefined>()
        expectTypeOf(dates.items[0]?.output).toMatchTypeOf<Date | undefined>()
        expectTypeOf(input).toEqualTypeOf<Date>()
        return normalize.toISOString()
      })
  })
})
