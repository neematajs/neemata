import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
  schemaOf,
} from '../src/effect/index.ts'
import {
  defineWorkflow as defineStandardWorkflow,
  implementWorkflow as implementStandardWorkflow,
} from '../src/index.ts'
import { fromPromise } from './support/effect.ts'

describe('workflow implementation chain', () => {
  const prefix = 'case'

  const embedding = defineTask({
    name: 'embedding.generate',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })

  const fallbackWorkflow = defineWorkflow({
    name: 'fallback-content',
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
  })
    .activity('content', {
      input: Schema.Struct({ scenario: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    .branch('caseContent', {
      output: Schema.Struct({ text: Schema.String }),
      cases: (helpers) => ({
        normal: helpers.activity({
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        }),
        fallback: helpers.workflow(fallbackWorkflow),
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

  it('requires explicit runnable declarations in implementation order', () => {
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .content((input) => fromPromise(async () => ({ text: input.scenario })), {
        input: (_outputs, input) => {
          expectTypeOf(prefix).toEqualTypeOf<string>()
          expectTypeOf(input).toEqualTypeOf<{
            readonly kind: 'normal' | 'fallback'
            readonly scenario: string
          }>()
          return { scenario: `${prefix}:${input.scenario}` }
        },
      })
      .caseContent({
        select: (_outputs, input): 'normal' | 'fallback' => input.kind,
        cases: ({ activity, workflow }) => ({
          normal: activity(
            (input) => fromPromise(async () => ({ text: input.text })),
            {
              input: ({ content }) => {
                expectTypeOf(content).toEqualTypeOf<{ readonly text: string }>()
                return { text: content.text }
              },
            },
          ),
          fallback: workflow(fallbackWorkflow, {
            input: (_outputs, input) => ({ scenario: input.scenario }),
          }),
        }),
      })
      .embedding(embedding, {
        input: ({ caseContent }) => ({ text: caseContent.text }),
      })
      .saveCase(
        (input) =>
          fromPromise(async () => ({
            caseId: `${input.scenario}:${input.embeddingId}`,
          })),
        {
          input: ({ embedding }, input) => ({
            scenario: input.scenario,
            embeddingId: embedding.id,
          }),
        },
      )
      .finish(({ saveCase }) =>
        fromPromise(() => ({ caseId: saveCase.caseId })),
      )

    expect(implementation).not.toHaveProperty('dependencies')
    expect(implementation.nodes.map((node) => node.name)).toStrictEqual([
      'content',
      'caseContent',
      'embedding',
      'saveCase',
    ])
    const [contentNode, branchNode, embeddingNode, saveCaseNode] =
      implementation.nodes

    expect(contentNode?.kind).toBe('activity')
    if (contentNode?.kind !== 'activity') throw new Error('Expected activity')
    expect(contentNode.input).toBeTypeOf('function')

    expect(branchNode?.kind).toBe('branch')
    if (branchNode?.kind !== 'branch') throw new Error('Expected branch')
    expect(branchNode.select).toBeTypeOf('function')
    expect(branchNode.cases.normal?.input).toBeTypeOf('function')

    expect(embeddingNode?.kind).toBe('task')
    if (embeddingNode?.kind !== 'task') throw new Error('Expected task')
    expect(embeddingNode.target).toBe(embedding)

    expect(saveCaseNode?.kind).toBe('activity')
    if (saveCaseNode?.kind !== 'activity') throw new Error('Expected activity')
    expect(saveCaseNode.input).toBeTypeOf('function')
    expect(implementation.finish).toBeTypeOf('function')
  })

  it('keeps activity implementation dependencies typed in workflow nodes', () => {
    const service = Context.Reference('test-service', {
      defaultValue: () => ({
        save: (text: string) => text.length,
      }),
    })
    const activityWorkflow = defineWorkflow({
      name: 'activity-dependencies',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ size: Schema.Number }),
    })
      .activity('save', {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ size: Schema.Number }),
      })
      .build()

    const inferred = implementWorkflow(activityWorkflow, { pool: 'test' })
      .save({
        handler: (input) =>
          Effect.gen(function* () {
            const dependency = yield* service
            expectTypeOf(dependency.save).toEqualTypeOf<
              (text: string) => number
            >()
            expectTypeOf(input.text).toEqualTypeOf<string>()

            return { size: dependency.save(input.text) }
          }),
      })
      .finish(({ save }) => fromPromise(() => save))

    const annotated = implementWorkflow(activityWorkflow, { pool: 'test' })
      .save({
        handler: (input: { readonly text: string }) =>
          service.pipe(
            Effect.map((dependency) => ({
              size: dependency.save(input.text),
            })),
          ),
      })
      .finish(({ save }) => fromPromise(() => save))

    expect(inferred.workflow).toBe(activityWorkflow)
    expect(annotated.workflow).toBe(activityWorkflow)
  })

  it('keeps activity implementation dependencies typed in branch and parallel cases', () => {
    const service = Context.Reference('test-service', {
      defaultValue: () => ({
        decorate: (text: string) => `${text}!`,
      }),
    })
    const io = Schema.Struct({ text: Schema.String })
    const activity = {
      handler: (input: typeof io.Type) =>
        service.pipe(
          Effect.map((dependency) => ({
            text: dependency.decorate(input.text),
          })),
        ),
    }
    const branched = defineWorkflow({
      name: 'branch-case-activity-dependencies',
      input: io,
      output: io,
    })
      .branch('chosen', {
        output: io,
        cases: (helpers) => ({
          normal: helpers.activity({ input: io, output: io }),
        }),
      })
      .build()
    const parallel = defineWorkflow({
      name: 'parallel-case-activity-dependencies',
      input: io,
      output: io,
    })
      .parallel('cases', (helpers) => ({
        normal: helpers.activity({ input: io, output: io }),
      }))
      .build()

    const branchImplementation = implementWorkflow(branched, { pool: 'test' })
      .chosen({
        select: () => 'normal',
        cases: ({ activity: defineActivity }) => ({
          normal: defineActivity(activity, {
            input: (_outputs, input) => input,
          }),
        }),
      })
      .finish(({ chosen }) => fromPromise(() => chosen))
    const parallelImplementation = implementWorkflow(parallel, { pool: 'test' })
      .cases(({ activity: defineActivity }) => ({
        normal: defineActivity(activity, {
          input: (_outputs, input) => input,
        }),
      }))
      .finish(({ cases }) => fromPromise(() => cases.normal))

    expect(branchImplementation.workflow).toBe(branched)
    expect(parallelImplementation.workflow).toBe(parallel)
  })

  it('accepts schema-derived annotations for optional parallel activity input', () => {
    const activityInput = Schema.Struct({
      caseBlueprint: Schema.String,
      name: Schema.optional(Schema.String),
    })
    const activityOutput = Schema.Struct({ ok: Schema.Boolean })
    const parallelWorkflow = defineWorkflow({
      name: 'optional-parallel-activity-input',
      input: Schema.Struct({ caseBlueprint: Schema.String }),
      output: activityOutput,
    })
      .parallel('cases', (helpers) => ({
        normal: helpers.activity({
          input: activityInput,
          output: activityOutput,
        }),
      }))
      .build()

    implementWorkflow(parallelWorkflow, { pool: 'test' })
      .cases(({ activity }) => ({
        normal: activity(
          (input: typeof activityInput.Type) =>
            fromPromise(async () => ({
              ok: input.name === undefined || input.name.length > 0,
            })),
          {
            input: (_outputs, input) => ({
              caseBlueprint: input.caseBlueprint,
            }),
          },
        ),
      }))
      .finish(({ cases }) => fromPromise(() => cases.normal))
  })

  it('infers branch output union when no common output is declared', () => {
    const outpatientWorkflow = defineWorkflow({
      name: 'outpatient-content',
      input: Schema.Struct({ scenario: Schema.String }),
      output: Schema.Struct({
        kind: Schema.Literal('outpatient'),
        text: Schema.String,
      }),
    }).build()

    const obstetricsWorkflow = defineWorkflow({
      name: 'obstetrics-content',
      input: Schema.Struct({ scenario: Schema.String }),
      output: Schema.Struct({
        kind: Schema.Literal('obstetrics'),
        obstetricsData: Schema.String,
      }),
    }).build()

    const branchingWorkflow = defineWorkflow({
      name: 'branching-content',
      input: Schema.Struct({
        kind: Schema.Union([
          Schema.Literal('outpatient'),
          Schema.Literal('obstetrics'),
        ]),
        scenario: Schema.String,
      }),
      // Definitions hold codecs; the adapter still knows their schemas.
      output: Schema.Union([
        schemaOf(outpatientWorkflow.output)!,
        schemaOf(obstetricsWorkflow.output)!,
      ]),
    })
      .branch('content', {
        cases: (helpers) => ({
          outpatient: helpers.workflow(outpatientWorkflow),
          obstetrics: helpers.workflow(obstetricsWorkflow),
        }),
      })
      .build()

    const implementation = implementWorkflow(branchingWorkflow, {
      pool: 'test',
    })
      .content({
        select: (_outputs, input) => input.kind,
        cases: ({ workflow }) => ({
          outpatient: workflow(outpatientWorkflow, {
            input: (_outputs, input) => ({ scenario: input.scenario }),
          }),
          obstetrics: workflow(obstetricsWorkflow, {
            input: (_outputs, input) => ({ scenario: input.scenario }),
          }),
        }),
      })
      .finish(({ content }) =>
        fromPromise(() => {
          expectTypeOf(content.kind).toEqualTypeOf<
            'outpatient' | 'obstetrics'
          >()

          if (content.kind === 'obstetrics') {
            expectTypeOf(content.obstetricsData).toEqualTypeOf<string>()
          }

          return content
        }),
      )

    expect(implementation.workflow).toBe(branchingWorkflow)
  })
})

describe('case normalization', () => {
  const text = z.string()

  it('uses null prototypes for branch and parallel implementations', () => {
    const workflow = defineStandardWorkflow({
      name: 'null-proto.cases',
      input: text,
    })
      .branch('choice', {
        output: text,
        cases: (h) => ({ ok: h.activity({ input: text, output: text }) }),
      })
      .parallel('pair', (h) => ({
        ok: h.activity({ input: text, output: text }),
      }))
      .build()
    const implementation = implementStandardWorkflow(workflow, { pool: 'test' })
      .choice({ select: () => 'ok', cases: () => ({ ok: (input) => input }) })
      .pair({ ok: (input) => input })
      .finish(({ pair }) => pair)

    for (const node of implementation.nodes) {
      if (node.kind !== 'branch' && node.kind !== 'parallel')
        throw new Error(`Unexpected node kind: ${node.kind}`)
      expect(Object.getPrototypeOf(node.cases)).toBeNull()
      expect(Object.keys(node.cases)).toEqual(['ok'])
    }
  })

  it('requires an own case implementation even for an inherited function name', () => {
    const workflow = defineStandardWorkflow({
      name: 'null-proto.inherited',
      input: text,
    })
      .parallel('pair', (h) => ({
        toString: h.activity({ input: text, output: text }),
      }))
      .build()

    expect(() =>
      implementStandardWorkflow(workflow, { pool: 'test' }).pair({}),
    ).toThrow('Missing workflow parallel case implementation [pair.toString]')
  })
})
