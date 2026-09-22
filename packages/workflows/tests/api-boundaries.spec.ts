import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import type { EffectSchema } from '../src/effect/index.ts'
import type * as workflows from '../src/index.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  schemaOf,
} from '../src/effect/index.ts'
import {
  defineTask as defineCoreTask,
  defineWorkflow as defineCoreWorkflow,
  implementWorkflow as implementCoreWorkflow,
  toStoredJsonSchema,
} from '../src/index.ts'
import { fromPromise } from './support/effect.ts'

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
      pool: 'test',
      handler(input) {
        return fromPromise(async () => {
          return { id: input.text }
        })
      },
    })

    const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
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
      implementWorkflow(workflow, { pool: 'test' })
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
      implementWorkflow(workflow, { pool: 'test' })
        .content((input) => fromPromise(async () => ({ text: input.scenario })))
        .caseContent({
          select: (_outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity(
              (input) =>
                fromPromise(async () => ({
                  kind: 'normal' as const,
                  text: input.text,
                })),
              { input: ({ content }) => ({ text: content.text }) },
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
      implementWorkflow(workflow, { pool: 'test' })
        .content((input) => fromPromise(async () => ({ text: input.scenario })))
        .caseContent({
          select: (_outputs, input) => input.kind,
          cases: ({ activity, workflow }) => ({
            normal: activity(
              (input) =>
                fromPromise(async () => ({
                  kind: 'normal' as const,
                  text: input.text,
                })),
              { input: ({ content }) => ({ text: content.text }) },
            ),
            fallback: workflow(childWorkflow),
          }),
        })
        .embedding(otherTask as any, {
          input: ({ caseContent }) => ({ text: caseContent.text }),
        }),
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
      pool: 'test',
      handler: (input) =>
        fromPromise(async () => {
          expectTypeOf(input).toEqualTypeOf<Date>()
          return input
        }),
    })

    implementWorkflow(dateWorkflow, { pool: 'test' })
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

    implementWorkflow(workflow, { pool: 'test' })
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
    >().not.toExtend<EffectSchema>()
    expectTypeOf<
      Schema.Codec<string, string, never, { readonly service: 'encode' }>
    >().not.toExtend<EffectSchema>()
  })

  it('reads a declared schema back from a definition', () => {
    const input = Schema.Struct({ at: Schema.DateFromString })
    const output = Schema.DateFromString
    const item = Schema.Number
    const task = defineTask({ name: 'schema-of', input, output })
    const workflow = defineWorkflow({ name: 'schema-of', input })
      .activity('step', { input, output })
      .mapTask('each', task, { item })
      .build()

    expect(schemaOf(task.input)).toBe(input)
    expect(schemaOf(task.output)).toBe(output)
    expect(schemaOf(workflow.nodes[0].output)).toBe(output)
    expect(schemaOf(workflow.nodes[1].item)).toBe(item)
    expect(schemaOf(workflow.output)).toBeUndefined()
    // The JSON Schema of the stored form comes from the same definition.
    expect(toStoredJsonSchema(task.input)).toMatchObject({
      type: 'object',
      properties: { at: { type: 'string' } },
    })
  })
})

// A step bound without a mapper receives the workflow input as is. These
// workflows take a string while their steps take a number, so every binding
// below needs a mapper; the `same` ones take the workflow input itself.
describe('core chain: mapper required for incompatible step inputs', () => {
  type Clock = { readonly clock: { readonly now: () => number } }
  const text = z.string()
  const count = z.number()
  const countTask = defineCoreTask({
    name: 'mapper.count',
    input: count,
    output: count,
  })
  const textTask = defineCoreTask({
    name: 'mapper.text',
    input: text,
    output: text,
  })
  const countChild = defineCoreWorkflow({
    name: 'mapper.count-child',
    input: count,
    output: count,
  }).build()
  const step = { input: count, output: count }
  const same = { input: text, output: text }

  it('rejects a task, activity or child workflow node without a mapper', () => {
    const taskNode = defineCoreWorkflow({
      name: 'mapper.task',
      input: text,
      output: count,
    })
      .task('step', countTask)
      .build()
    const activityNode = defineCoreWorkflow({
      name: 'mapper.activity',
      input: text,
      output: count,
    })
      .activity('step', step)
      .build()
    const childNode = defineCoreWorkflow({
      name: 'mapper.child',
      input: text,
      output: count,
    })
      .workflow('step', countChild)
      .build()

    // @ts-expect-error The task takes a number, the workflow a string.
    implementCoreWorkflow(taskNode, { pool: 'test' }).step(countTask)
    implementCoreWorkflow(taskNode, { pool: 'test' }).step(
      countTask,
      // @ts-expect-error Options without a mapper do not help.
      { idempotency: () => ['key'] },
    )
    implementCoreWorkflow(activityNode, { pool: 'test' })
      // @ts-expect-error The activity takes a number, the workflow a string.
      .step((input) => input + 1)
    // @ts-expect-error The child takes a number, the workflow a string.
    implementCoreWorkflow(childNode, { pool: 'test' }).step(countChild)

    implementCoreWorkflow(taskNode, { pool: 'test' })
      .step(countTask, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => step)
    implementCoreWorkflow(childNode, { pool: 'test' })
      .step(countChild, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => step)
    const mapped = implementCoreWorkflow(activityNode, { pool: 'test' })
      .step((input, _lifecycle, env: Clock) => input + env.clock.now(), {
        input: (_outputs, input) => Number(input),
      })
      .finish(({ step }) => step)
    expectTypeOf<workflows.Env<typeof mapped>>().toEqualTypeOf<Clock>()
  })

  it('keeps the mapper optional when the step takes the workflow input', () => {
    const compatible = defineCoreWorkflow({
      name: 'mapper.compatible',
      input: text,
      output: text,
    })
      .task('task', textTask)
      .activity('activity', same)
      .parallel('pair', (h) => ({
        task: h.task(textTask),
        bare: h.activity(same),
      }))
      .build()

    const implementation = implementCoreWorkflow(compatible, { pool: 'test' })
      .task(textTask)
      .activity((input, _lifecycle, env: Clock) => `${input}${env.clock.now()}`)
      .pair({ task: textTask, bare: (input) => input })
      .finish(({ pair }) => pair.bare)
    expectTypeOf<workflows.Env<typeof implementation>>().toEqualTypeOf<Clock>()
    expect(implementation.nodes).toHaveLength(3)
  })

  it('rejects parallel members and branch cases without a mapper', () => {
    const cases = defineCoreWorkflow({
      name: 'mapper.cases',
      input: text,
      output: count,
    })
      .parallel('pair', (h) => ({
        task: h.task(countTask),
        activity: h.activity(step),
      }))
      .branch('pick', {
        cases: (h) => ({ task: h.task(countTask), activity: h.activity(step) }),
        output: count,
      })
      .build()
    const chain = implementCoreWorkflow(cases, { pool: 'test' })

    chain.pair(({ task, activity }) => ({
      // @ts-expect-error The task member takes a number.
      task: task(countTask),
      // @ts-expect-error The activity member takes a number.
      activity: activity((input) => input + 1),
    }))
    chain.pair({
      // @ts-expect-error A bare task has no mapper.
      task: countTask,
      // @ts-expect-error Nor has a bare handler.
      activity: (input: number) => input + 1,
    })

    const mapped = chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity(
          (input, _lifecycle, env: Clock) => input + env.clock.now(),
          { input: (_outputs, input) => Number(input) },
        ),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          task: task(countTask, { input: ({ pair }) => pair.task }),
          activity: activity((input) => input + 1, {
            input: ({ pair }) => pair.activity,
          }),
        }),
      })
      .finish(({ pick }) => pick)
    expectTypeOf<workflows.Env<typeof mapped>>().toEqualTypeOf<Clock>()

    chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => input + 1, {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          // @ts-expect-error The task case takes a number.
          task: task(countTask),
          // @ts-expect-error The activity case takes a number.
          activity: activity((input) => input + 1),
        }),
      })
  })

  it('stays permissive for untyped inputs', () => {
    const anyTask = defineCoreTask({
      name: 'mapper.any',
      input: z.any(),
      output: z.any(),
    })
    const untyped = defineCoreWorkflow({
      name: 'mapper.untyped',
      input: text,
      output: count,
    })
      .task('loose', anyTask)
      .build()
    const erased = defineCoreWorkflow({
      name: 'mapper.erased',
      input: z.any(),
      output: count,
    })
      .task('step', countTask)
      .build()

    implementCoreWorkflow(untyped, { pool: 'test' })
      .loose(anyTask)
      .finish(() => 1)
    implementCoreWorkflow(erased, { pool: 'test' })
      .step(countTask)
      .finish(({ step }) => step)
  })
})
