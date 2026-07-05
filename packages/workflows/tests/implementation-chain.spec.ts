import { createValueInjectable, type DependencyContext } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'

describe('workflow implementation chain', () => {
  const prefix = createValueInjectable('case')

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
    .task('embedding', embedding)
    .activity('saveCase', {
      input: t.object({ scenario: t.string(), embeddingId: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
    .build()

  it('requires explicit runnable declarations in implementation order', () => {
    const implementation = implementWorkflow(workflow, {
      dependencies: { prefix },
    })
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (ctx, _outputs, input) => {
          expectTypeOf(ctx.prefix).toEqualTypeOf<string>()
          // @ts-expect-error workflow input mapper scope is typed
          void input.missing
          return { scenario: `${ctx.prefix}:${input.scenario}` }
        },
      })
      .caseContent({
        select: (_ctx, _outputs, input): 'normal' | 'fallback' => input.kind,
        cases: ({ activity, workflow }) => ({
          normal: activity(async (_ctx, input) => ({ text: input.text }), {
            input: (_ctx, { content }) => {
              // @ts-expect-error branch case mapper scope is typed
              void content.missing
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
      input: t.object({ text: t.string() }),
      output: t.object({ size: t.number() }),
    })
      .activity('save', {
        input: t.object({ text: t.string() }),
        output: t.object({ size: t.number() }),
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

  it('infers branch output union when no common output is declared', () => {
    const outpatientWorkflow = defineWorkflow({
      name: 'outpatient-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({
        kind: t.literal('outpatient'),
        text: t.string(),
      }),
    }).build()

    const obstetricsWorkflow = defineWorkflow({
      name: 'obstetrics-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({
        kind: t.literal('obstetrics'),
        obstetricsData: t.string(),
      }),
    }).build()

    const branchingWorkflow = defineWorkflow({
      name: 'branching-content',
      input: t.object({
        kind: t.union(t.literal('outpatient'), t.literal('obstetrics')),
        scenario: t.string(),
      }),
      output: t.union(outpatientWorkflow.output!, obstetricsWorkflow.output!),
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
