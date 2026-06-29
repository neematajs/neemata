import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'

describe('workflow orchestration nodes', () => {
  const embeddingTask = defineTask({
    name: 'embedding.generate',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })

  const childWorkflow = defineWorkflow({
    name: 'child-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()

  const workflow = defineWorkflow({
    name: 'curriculum-generation',
    input: t.object({
      scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
    }),
    output: t.object({ ok: t.boolean() }),
  })
    .activity('load', {
      input: t.object({
        scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
      }),
      output: t.object({
        scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
      }),
    })
    .parallel('sections', (helpers) => ({
      summary: helpers.activity({
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      }),
      embedding: helpers.task(embeddingTask),
      child: helpers.workflow(childWorkflow),
    }))
    .mapWorkflow('caseRuns', childWorkflow, {
      item: t.object({ id: t.string(), text: t.string() }),
      mode: 'start-only',
    })
    .mapTask('embeddings', embeddingTask, {
      item: t.object({ id: t.string(), text: t.string() }),
      mode: 'wait-all',
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
          // @ts-expect-error map item mapper is inferred from item schema
          void item.missing
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
        input: t.object({ text: t.string() }),
      })
        .mapTask('embeddings', embeddingTask, {
          item: t.string(),
          mode: 'wait-all',
          concurrency: 0,
        })
        .build(),
    ).toThrow('Map node concurrency must be a positive integer')

    expect(() =>
      defineWorkflow({
        name: 'invalid-map-workflow-concurrency',
        input: t.object({ text: t.string() }),
      })
        .mapWorkflow('children', childWorkflow, {
          item: t.string(),
          mode: 'wait-all',
          concurrency: Number.NaN,
        })
        .build(),
    ).toThrow('Map node concurrency must be a positive integer')
  })
})
