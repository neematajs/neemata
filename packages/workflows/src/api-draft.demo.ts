import { createValueInjectable, createHandler } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from './index.ts'

const model = createValueInjectable('text-embedding-3-small')

const embeddingTask = defineTask({
  name: 'embedding.generate',
  input: t.object({ text: t.string() }),
  output: t.object({ id: t.string() }),
  retry: { attempts: 3, backoff: 'exponential' },
})

const fallbackWorkflow = defineWorkflow({
  name: 'fallback-content',
  input: t.object({ scenario: t.string() }),
  output: t.object({ text: t.string() }),
}).build()

export const caseWorkflow = defineWorkflow({
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
    retry: { attempts: 3 },
  })
  .branch('caseContent', {
    output: t.object({ text: t.string() }),
    cases: ({ activity, workflow }) => ({
      normal: activity({
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      }),
      fallback: workflow(fallbackWorkflow),
    }),
  })
  .parallel('postProcessing', ({ activity, task }) => ({
    audit: activity({
      input: t.object({ text: t.string() }),
      output: t.object({ ok: t.boolean() }),
    }),
    embedding: task(embeddingTask),
  }))
  .activity('saveCase', {
    input: t.object({ scenario: t.string(), embeddingId: t.string() }),
    output: t.object({ caseId: t.string() }),
  })
  .build()

export const curriculumWorkflow = defineWorkflow({
  name: 'curriculum-generation',
  input: t.object({
    scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
  }),
  output: t.object({ started: t.number() }),
})
  .activity('generateScenarios', {
    input: t.object({
      scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
    }),
    output: t.object({
      scenarios: t.array(t.object({ id: t.string(), text: t.string() })),
    }),
  })
  .mapWorkflow('caseRuns', caseWorkflow, {
    item: t.object({ id: t.string(), text: t.string() }),
    mode: 'start-only',
  })
  .mapTask('embeddings', embeddingTask, {
    item: t.object({ id: t.string(), text: t.string() }),
    mode: 'wait-all',
  })
  .build()

export const embeddingImpl = implementTask(embeddingTask, {
  dependencies: { model },
  idempotency: (_ctx, input) => ['embedding.generate', input.text],
  async handler(ctx, input) {
    return { id: `${ctx.model}:${input.text.length}` }
  },
})

const someHandler = createHandler({
  dependencies: { model },
  handler: async (ctx, input: { scenario: string }) => ({
    text: input.scenario,
  }),
})

export const caseWorkflowImpl = implementWorkflow(caseWorkflow)
  .content(someHandler, {
    input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
  })
  .caseContent({
    select: (_ctx, _outputs, input): 'normal' | 'fallback' => input.kind,
    cases: ({ activity, workflow }) => ({
      normal: activity(async (_ctx, input) => ({ text: input.text }), {
        input: (_ctx, { content }) => ({ text: content.text }),
      }),
      fallback: workflow(fallbackWorkflow, {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      }),
    }),
  })
  .postProcessing(({ activity, task }) => ({
    audit: activity(async (_ctx, input) => ({ ok: Boolean(input.text) }), {
      input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
    }),
    embedding: task(embeddingTask, {
      input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
    }),
  }))
  .saveCase(
    {
      handler: async (_ctx, input) => ({
        caseId: `${input.scenario}:${input.embeddingId}`,
      }),
    },
    {
      input: (_ctx, { postProcessing }, input) => ({
        scenario: input.scenario,
        embeddingId: postProcessing.embedding.id,
      }),
    },
  )
  .finish((_ctx, { saveCase }) => ({ caseId: saveCase.caseId }))

export const fallbackWorkflowImpl = implementWorkflow(fallbackWorkflow).finish(
  (_ctx, _outputs, input) => ({ text: input.scenario }),
)

export const curriculumWorkflowImpl = implementWorkflow(curriculumWorkflow)
  .generateScenarios(async (_ctx, input) => ({ scenarios: input.scenarios }), {
    input: (_ctx, _outputs, input) => input,
  })
  .caseRuns(caseWorkflow, {
    items: (_ctx, { generateScenarios }) => generateScenarios.scenarios,
    input: (_ctx, _outputs, item) => ({
      kind: 'normal' as const,
      scenario: item.text,
    }),
  })
  .embeddings(embeddingTask, {
    items: (_ctx, { generateScenarios }) => generateScenarios.scenarios,
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })
  .finish((_ctx, { caseRuns }) => ({ started: caseRuns.items.length }))
