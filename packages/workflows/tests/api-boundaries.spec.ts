import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as workflows from '../src/index.ts'
import { fromPromise } from './support/effect.ts'

const { defineTask, defineWorkflow, implementTask, implementWorkflow } =
  workflows

describe('workflow API boundaries', () => {
  const prefix = 'prefix'

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
      handler(input) {
        return fromPromise(async () => {
          return { id: input.text }
        })
      },
    })

    const workflowImpl = implementWorkflow(workflow)
      .content((input) => fromPromise(async () => ({ text: input.scenario })), {
        input: (_outputs, input) => ({ scenario: input.scenario }),
        idempotency: (_outputs, input) => [prefix, input.scenario],
      })
      .caseContent({
        select: (_outputs, input) => input.kind,
        cases: ({ activity, workflow }) => ({
          normal: activity(
            (input) =>
              fromPromise(async () => ({
                kind: 'normal' as const,
                text: input.text,
              })),
            {
              input: ({ content }) => ({ text: content.text }),
              idempotency: ({ content }) => ['normal', content.text],
            },
          ),
          fallback: workflow(childWorkflow, {
            input: (_outputs, input) => ({ scenario: input.scenario }),
            idempotency: (_outputs, input) => ['fallback', input.scenario],
          }),
        }),
      })
      .embedding(embedding, {
        input: ({ caseContent }) => ({ text: caseContent.text }),
        idempotency: ({ caseContent }) => ['embedding', caseContent.text],
      })
      .saveCase(
        (input) => fromPromise(async () => ({ caseId: input.embeddingId })),
        {
          input: ({ embedding }, input) => ({
            scenario: input.scenario,
            embeddingId: embedding.id,
          }),
          idempotency: (_outputs, input) => ['save', input.scenario],
        },
      )
      .finish(({ saveCase }) =>
        fromPromise(() => ({ caseId: saveCase.caseId })),
      )

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
        .content((input) => fromPromise(async () => ({ text: input.scenario })))
        .caseContent({
          select: (_outputs, input) => input.kind,
          cases: (({ activity }) => ({
            normal: activity((input) =>
              fromPromise(async () => ({
                kind: 'normal' as const,
                text: input.text,
              })),
            ),
          })) as any,
        }),
    ).toThrow(
      'Missing workflow branch case implementation [caseContent.fallback]',
    )

    expect(() =>
      implementWorkflow(workflow)
        .content((input) => fromPromise(async () => ({ text: input.scenario })))
        .caseContent({
          select: (_outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity((input) =>
              fromPromise(async () => ({
                kind: 'normal' as const,
                text: input.text,
              })),
            ),
            fallback: workflow(childWorkflow),
            extra: activity(() =>
              fromPromise(async () => ({
                kind: 'normal' as const,
                text: 'extra',
              })),
            ),
          }),
        }),
    ).toThrow('Unknown workflow branch case implementation [caseContent.extra]')

    expect(() =>
      implementWorkflow(workflow)
        .content((input) => fromPromise(async () => ({ text: input.scenario })))
        .caseContent({
          select: (_outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity((input) =>
              fromPromise(async () => ({
                kind: 'normal' as const,
                text: input.text,
              })),
            ),
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

    expectTypeOf<workflows.TaskInput<typeof dateTask>>().toEqualTypeOf<Date>()
    expectTypeOf<workflows.TaskOutput<typeof dateTask>>().toEqualTypeOf<Date>()
    expectTypeOf<
      workflows.WorkflowInput<typeof dateWorkflow>
    >().toEqualTypeOf<Date>()
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
      handler: (input) =>
        fromPromise(async () => {
          expectTypeOf(input).toEqualTypeOf<Date>()
          return input
        }),
    })

    implementWorkflow(dateWorkflow)
      .normalize(
        (input) =>
          fromPromise(async () => {
            expectTypeOf(input).toEqualTypeOf<Date>()
            return input
          }),
        {
          input: (_outputs, input) => {
            expectTypeOf(input).toEqualTypeOf<Date>()
            return input
          },
        },
      )
      .dates(dateTask, {
        items: (_outputs, input) => {
          expectTypeOf(input).toEqualTypeOf<Date>()
          return [input]
        },
        input: (_outputs, item, input) => {
          expectTypeOf(item).toEqualTypeOf<Date>()
          expectTypeOf(input).toEqualTypeOf<Date>()
          return item
        },
      })
      .finish(({ normalize, dates }, input) =>
        fromPromise(() => {
          expectTypeOf(normalize).toEqualTypeOf<Date>()
          expectTypeOf(dates.items[0]?.item).toExtend<Date | undefined>()
          expectTypeOf(dates.items[0]?.output).toExtend<Date | undefined>()
          expectTypeOf(input).toEqualTypeOf<Date>()
          return normalize
        }),
      )
  })

  it('keeps branch and parallel activity mappers and handlers decoded', () => {
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
            (input) =>
              fromPromise(async () => {
                expectTypeOf(input).toEqualTypeOf<Date>()
                return input
              }),
            { input: (_outputs, input) => input },
          ),
        }),
      })
      .members((h) => ({
        date: h.activity(
          (input) =>
            fromPromise(async () => {
              expectTypeOf(input).toEqualTypeOf<Date>()
              return input
            }),
          { input: ({ choice }) => choice },
        ),
      }))
      .finish(({ members }) => fromPromise(() => members.date))

    expectTypeOf<
      Schema.Codec<string, string, { readonly service: 'decode' }>
    >().not.toExtend<workflows.Schema>()
    expectTypeOf<
      Schema.Codec<string, string, never, { readonly service: 'encode' }>
    >().not.toExtend<workflows.Schema>()
  })
})
