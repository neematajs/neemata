import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'

describe('workflow orchestration nodes', () => {
  const embeddingTask = defineTask({
    name: 'embedding.generate',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })

  const childWorkflow = defineWorkflow({
    name: 'child-content',
    input: Schema.Struct({ scenario: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
  }).build()

  const workflow = defineWorkflow({
    name: 'curriculum-generation',
    input: Schema.Struct({
      scenarios: Schema.Array(
        Schema.Struct({ id: Schema.String, text: Schema.String }),
      ),
    }),
    output: Schema.Struct({ ok: Schema.Boolean }),
  })
    .activity('load', {
      input: Schema.Struct({
        scenarios: Schema.Array(
          Schema.Struct({ id: Schema.String, text: Schema.String }),
        ),
      }),
      output: Schema.Struct({
        scenarios: Schema.Array(
          Schema.Struct({ id: Schema.String, text: Schema.String }),
        ),
      }),
    })
    .parallel('sections', (helpers) => ({
      summary: helpers.activity({
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      }),
      embedding: helpers.task(embeddingTask),
      child: helpers.workflow(childWorkflow),
    }))
    .mapWorkflow('caseRuns', childWorkflow, {
      item: Schema.Struct({ id: Schema.String, text: Schema.String }),
    })
    .mapTask('embeddings', embeddingTask, {
      item: Schema.Struct({ id: Schema.String, text: Schema.String }),
    })
    .build()

  it('keeps orchestration nodes explicit in implementation order', () => {
    const implementation = implementWorkflow(workflow)
      .load(async (_ctx, input) => ({ scenarios: input.scenarios }), {
        input: (_ctx, _outputs, input) => input,
      })
      .sections(({ activity, task, workflow }) => ({
        summary: activity(async (_ctx, input) => ({ text: input.text }), {
          input: (_ctx, { load }) => ({
            text: load.scenarios.at(0)?.text ?? '',
          }),
        }),
        embedding: task(embeddingTask, {
          input: (_ctx, { load }) => ({
            text: load.scenarios.at(0)?.text ?? '',
          }),
        }),
        child: workflow(childWorkflow, {
          input: (_ctx, { load }) => ({
            scenario: load.scenarios.at(0)?.text ?? '',
          }),
        }),
      }))
      .caseRuns(childWorkflow, {
        items: (_ctx, { load }) => load.scenarios,
        input: (_ctx, _outputs, item) => {
          const text: string = item.text
          expectTypeOf(item).toEqualTypeOf<{
            readonly id: string
            readonly text: string
          }>()
          return { scenario: text }
        },
      })
      .embeddings(embeddingTask, {
        items: (_ctx, { load }) => load.scenarios,
        input: (_ctx, _outputs, item) => {
          const id: string = item.id
          expect(id).toBeTypeOf('string')
          return { text: item.text }
        },
      })
      .finish((_ctx, { sections, caseRuns, embeddings }) => {
        expectTypeOf(sections.summary.text).toEqualTypeOf<string>()
        expectTypeOf(sections.embedding.id).toEqualTypeOf<string>()
        expectTypeOf(sections.child.text).toEqualTypeOf<string>()
        expectTypeOf(caseRuns.items.at(0)?.runId).toEqualTypeOf<
          string | undefined
        >()
        expectTypeOf(embeddings.items.at(0)?.output.id).toEqualTypeOf<
          string | undefined
        >()
        return { ok: true }
      })

    expect(implementation.nodes.map((node) => node.name)).toStrictEqual([
      'load',
      'sections',
      'caseRuns',
      'embeddings',
    ])
    const [, sectionsNode, caseRunsNode, embeddingsNode] = implementation.nodes

    expect(sectionsNode?.kind).toBe('parallel')
    if (sectionsNode?.kind !== 'parallel') throw new Error('Expected parallel')
    expect(sectionsNode.cases.summary?.input).toBeTypeOf('function')

    expect(caseRunsNode?.kind).toBe('mapWorkflow')
    if (caseRunsNode?.kind !== 'mapWorkflow') {
      throw new Error('Expected mapWorkflow')
    }
    expect(caseRunsNode.items).toBeTypeOf('function')
    expect(caseRunsNode.input).toBeTypeOf('function')

    expect(embeddingsNode?.kind).toBe('mapTask')
    if (embeddingsNode?.kind !== 'mapTask') throw new Error('Expected mapTask')
    expect(embeddingsNode.target).toBe(embeddingTask)
  })

  it('rejects invalid map concurrency at declaration time', () => {
    expect(() =>
      defineWorkflow({
        name: 'invalid-map-task-concurrency',
        input: Schema.Struct({ text: Schema.String }),
      })
        .mapTask('embeddings', embeddingTask, {
          item: Schema.String,

          concurrency: 0,
        })
        .build(),
    ).toThrow('Map node concurrency must be a positive integer')

    expect(() =>
      defineWorkflow({
        name: 'invalid-map-workflow-concurrency',
        input: Schema.Struct({ text: Schema.String }),
      })
        .mapWorkflow('children', childWorkflow, {
          item: Schema.String,

          concurrency: Number.NaN,
        })
        .build(),
    ).toThrow('Map node concurrency must be a positive integer')
  })
})
