import { createValueInjectable, type DependencyContext } from '@nmtjs/core'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'

describe('workflow implementation chain', () => {
  const prefix = createValueInjectable('case')

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
    const implementation = implementWorkflow(workflow, {
      dependencies: { prefix },
    })
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (ctx, _outputs, input) => {
          expectTypeOf(ctx.prefix).toEqualTypeOf<string>()
          expectTypeOf(input).toEqualTypeOf<{
            readonly kind: 'normal' | 'fallback'
            readonly scenario: string
          }>()
          return { scenario: `${ctx.prefix}:${input.scenario}` }
        },
      })
      .caseContent({
        select: (_ctx, _outputs, input): 'normal' | 'fallback' => input.kind,
        cases: ({ activity, workflow }) => ({
          normal: activity(async (_ctx, input) => ({ text: input.text }), {
            input: (_ctx, { content }) => {
              expectTypeOf(content).toEqualTypeOf<{ readonly text: string }>()
              return { text: content.text }
            },
          }),
          fallback: workflow(fallbackWorkflow, {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
        }),
      })
      .embedding(embedding, {
        input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
      })
      .saveCase(
        async (_ctx, input) => ({
          caseId: `${input.scenario}:${input.embeddingId}`,
        }),
        {
          input: (_ctx, { embedding }, input) => ({
            scenario: input.scenario,
            embeddingId: embedding.id,
          }),
        },
      )
      .finish((_ctx, { saveCase }) => ({ caseId: saveCase.caseId }))

    expect(implementation.dependencies).toStrictEqual({ prefix })
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
    const service = createValueInjectable({
      save: (text: string) => text.length,
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

    const inferred = implementWorkflow(activityWorkflow)
      .save({
        dependencies: { service },
        handler: (ctx, input) => {
          expectTypeOf(ctx.service.save).toEqualTypeOf<
            (text: string) => number
          >()
          expectTypeOf(input.text).toEqualTypeOf<string>()

          return { size: ctx.service.save(input.text) }
        },
      })
      .finish((_ctx, { save }) => save)

    const annotated = implementWorkflow(activityWorkflow)
      .save({
        dependencies: { service },
        handler: (
          ctx: DependencyContext<{ service: typeof service }>,
          input,
        ) => ({ size: ctx.service.save(input.text) }),
      })
      .finish((_ctx, { save }) => save)

    expect(inferred.workflow).toBe(activityWorkflow)
    expect(annotated.workflow).toBe(activityWorkflow)
  })

  it('keeps activity implementation dependencies typed in branch and parallel cases', () => {
    const service = createValueInjectable({
      decorate: (text: string) => `${text}!`,
    })
    const io = Schema.Struct({ text: Schema.String })
    const activity = {
      dependencies: { service },
      handler: (
        ctx: DependencyContext<{ service: typeof service }>,
        input: typeof io.Type,
      ) => ({ text: ctx.service.decorate(input.text) }),
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

    const branchImplementation = implementWorkflow(branched)
      .chosen({
        select: () => 'normal',
        cases: ({ activity: defineActivity }) => ({
          normal: defineActivity(activity, {
            input: (_ctx, _outputs, input) => input,
          }),
        }),
      })
      .finish((_ctx, { chosen }) => chosen)
    const parallelImplementation = implementWorkflow(parallel)
      .cases(({ activity: defineActivity }) => ({
        normal: defineActivity(activity, {
          input: (_ctx, _outputs, input) => input,
        }),
      }))
      .finish((_ctx, { cases }) => cases.normal)

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

    implementWorkflow(parallelWorkflow)
      .cases(({ activity }) => ({
        normal: activity(
          async (_ctx, input: typeof activityInput.Type) => ({
            ok: input.name === undefined || input.name.length > 0,
          }),
          {
            input: (_ctx, _outputs, input) => ({
              caseBlueprint: input.caseBlueprint,
            }),
          },
        ),
      }))
      .finish((_ctx, { cases }) => cases.normal)
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
      output: Schema.Union([
        outpatientWorkflow.output!,
        obstetricsWorkflow.output!,
      ]),
    })
      .branch('content', {
        cases: (helpers) => ({
          outpatient: helpers.workflow(outpatientWorkflow),
          obstetrics: helpers.workflow(obstetricsWorkflow),
        }),
      })
      .build()

    const implementation = implementWorkflow(branchingWorkflow)
      .content({
        select: (_ctx, _outputs, input) => input.kind,
        cases: ({ workflow }) => ({
          outpatient: workflow(outpatientWorkflow, {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
          obstetrics: workflow(obstetricsWorkflow, {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
        }),
      })
      .finish((_ctx, { content }) => {
        expectTypeOf(content.kind).toEqualTypeOf<'outpatient' | 'obstetrics'>()

        if (content.kind === 'obstetrics') {
          expectTypeOf(content.obstetricsData).toEqualTypeOf<string>()
        }

        return content
      })

    expect(implementation.workflow).toBe(branchingWorkflow)
  })
})
