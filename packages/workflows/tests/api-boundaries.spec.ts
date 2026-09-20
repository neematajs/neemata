import { createValueInjectable } from '@nmtjs/core'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as workflows from '../src/index.ts'

const { defineTask, defineWorkflow, implementTask, implementWorkflow } =
  workflows

describe('workflow API boundaries', () => {
  const prefix = createValueInjectable('prefix')

  const embedding = defineTask({
    name: 'embedding.generate',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
    idempotency: (input) => ['embedding.generate', input.text],
  })

  const childWorkflow = defineWorkflow({
    name: 'child',
    input: Schema.Struct({ scenario: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
  }).build()

  const workflow = defineWorkflow({
    name: 'case-generation',
    input: Schema.Struct({
      kind: Schema.Union([
        Schema.Literal('normal'),
        Schema.Literal('fallback'),
      ]),
      scenario: Schema.String,
    }),
    output: Schema.Struct({ caseId: Schema.String }),
    retention: '30d',
    idempotency: (input) => ['case-generation', input.scenario],
    tags: (input) => ({ kind: input.kind }),
  })
    .activity('content', {
      input: Schema.Struct({ scenario: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    .branch('caseContent', {
      cases: (helpers) => ({
        normal: helpers.activity({
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({
            kind: Schema.Literal('normal'),
            text: Schema.String,
          }),
        }),
        fallback: helpers.workflow(childWorkflow),
      }),
    })
    .task('embedding', embedding)
    .activity('saveCase', {
      input: Schema.Struct({
        scenario: Schema.String,
        embeddingId: Schema.String,
      }),
      output: Schema.Struct({ caseId: Schema.String }),
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
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ id: Schema.String }),
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
      input: Schema.DateFromString,
      output: Schema.DateFromString,
    })
    const dateWorkflow = defineWorkflow({
      name: 'date.workflow',
      input: Schema.DateFromString,
      output: Schema.DateFromString,
    })
      .activity('normalize', {
        input: Schema.DateFromString,
        output: Schema.DateFromString,
      })
      .mapTask('dates', dateTask, {
        item: Schema.DateFromString,
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
        expectTypeOf(dates.items[0]?.item).toExtend<Date | undefined>()
        expectTypeOf(dates.items[0]?.output).toExtend<Date | undefined>()
        expectTypeOf(input).toEqualTypeOf<Date>()
        return normalize.toISOString()
      })
  })

  it('keeps branch and parallel activity mappers encoded while handlers receive decoded input', () => {
    const workflow = defineWorkflow({
      name: 'case-codecs',
      input: Schema.DateFromString,
      output: Schema.DateFromString,
    })
      .branch('choice', {
        output: Schema.DateFromString,
        cases: (h) => ({
          date: h.activity({
            input: Schema.DateFromString,
            output: Schema.DateFromString,
          }),
        }),
      })
      .parallel('members', (h) => ({
        date: h.activity({
          input: Schema.DateFromString,
          output: Schema.DateFromString,
        }),
      }))
      .build()

    implementWorkflow(workflow)
      .choice({
        select: () => 'date',
        cases: (h) => ({
          date: h.activity(
            async (_ctx, input) => {
              expectTypeOf(input).toEqualTypeOf<Date>()
              return input.toISOString()
            },
            { input: (_ctx, _outputs, input) => input.toISOString() },
          ),
        }),
      })
      .members((h) => ({
        date: h.activity(
          async (_ctx, input) => {
            expectTypeOf(input).toEqualTypeOf<Date>()
            return input.toISOString()
          },
          { input: (_ctx, { choice }) => choice.toISOString() },
        ),
      }))
      .finish((_ctx, { members }) => members.date.toISOString())

    expectTypeOf<
      Schema.Codec<string, string, { readonly service: 'decode' }>
    >().not.toExtend<workflows.Schema>()
    expectTypeOf<
      Schema.Codec<string, string, never, { readonly service: 'encode' }>
    >().not.toExtend<workflows.Schema>()
  })
})
