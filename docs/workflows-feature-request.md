# Feature Request: Workflow APIs Needed Beyond Current Jobs

## Summary

The new `@nmtjs/workflows` direction is a good fit for complex orchestration:
workflow contracts are separate from implementations, reusable tasks are distinct
from local activities, and branch cases model domain choices better than ad hoc
`switch` blocks inside job handlers.

However, reproducing Casenetwork's current generation jobs with the workflow API
shows several missing public APIs. These are not runtime details; they affect how
users express durable workflows safely.

## Source Use Case

Casenetwork has two high-pressure workflow shapes:

1. **Case generation**
   - Choose outpatient vs obstetrics flow.
   - Run child content generation workflow.
   - Run child question generation workflow.
   - Save generated case.
   - Generate embedding.

2. **Curriculum generation**
   - Generate specs in pages.
   - Dedupe specs.
   - Generate scenarios in batches.
   - Start one case-generation run per scenario.
   - Track progress and usage across long-running work.

These are currently implemented with Neemata jobs, but the code uses jobs as a
workflow engine.

## Mismatch 1: Parallel Sections

### Current Jobs

Jobs can express a static parallel group:

```ts
export const outpatientCaseContentGenerationJob = n
  .job({ name: 'case-content-generation', input, output, progress })
  .step(draftCaseStep)
  .step(researchStep)
  .step(caseBlueprintStep)
  .step(reviewStep)
  .step(reviewApplicationStep)
  .steps(
    patientBackgroundStep,
    differentialDiagnosisStep,
    labsAndDiagnosticsStep,
    treatmentPlanStep,
    outcomeStep,
    caseIdentityStep,
  )
  .step(composeOutpatientCaseContentStep)
  .return(...)
```

This is important: each section uses the same post-review snapshot and can run
independently.

### Current Workflow Draft

The workflow demo must serialize those nodes:

```ts
defineWorkflow({ name: 'outpatient-case-content-generation', input, output })
  .activity('draftCase', ...)
  .activity('research', ...)
  .activity('blueprint', ...)
  .activity('review', ...)
  .activity('applyReview', ...)
  .activity('patientBackground', ...)
  .activity('differentialDiagnosis', ...)
  .activity('labsAndDiagnostics', ...)
  .activity('treatmentPlan', ...)
  .activity('outcome', ...)
  .activity('caseIdentity', ...)
  .activity('composeContent', ...)
```

That loses the public orchestration contract. Putting `Promise.all` inside one
activity would also hide retry, timeout, progress, logs, and per-section state.

### Requested API

```ts
defineWorkflow({ name: 'outpatient-case-content-generation', input, output })
  .activity('draftCase', ...)
  .activity('research', ...)
  .activity('blueprint', ...)
  .activity('review', ...)
  .activity('applyReview', ...)
  .parallel('sections', ({ activity }) => ({
    patientBackground: activity({ input: ({ applyReview }) => ..., output }),
    differentialDiagnosis: activity({ input: ({ applyReview }) => ..., output }),
    labsAndDiagnostics: activity({ input: ({ applyReview }) => ..., output }),
    treatmentPlan: activity({ input: ({ applyReview }) => ..., output }),
    outcome: activity({ input: ({ applyReview }) => ..., output }),
    caseIdentity: activity({ input: ({ applyReview }) => ..., output }),
  }))
  .activity('composeContent', {
    input: ({ sections }) => ({
      patientBackground: sections.patientBackground,
      differentialDiagnosis: sections.differentialDiagnosis,
    }),
    output,
  })
```

Requirements:

- All parallel siblings see the same prior scope snapshot.
- Each sibling keeps own retry/timeout/idempotency.
- Output is available as structured object under group name.
- Runtime can show per-sibling progress and errors.

## Mismatch 2: Dynamic Fan-Out Child Workflows

### Current Jobs

Curriculum generation starts one case-generation job per generated scenario:

```ts
for (const spec of specsWithScenarios) {
  await jobManager.add(caseGenerationJob, {
    scenario: spec.scenario,
    curriculumId: data.curriculumId,
    kind: data.defaultCaseKind,
    dreyfusLevels: spec.dreyfusLevels,
  })
}
```

This is fragile today because child job IDs are not checkpointed by the
framework, but the workflow need is real.

### Current Workflow Draft

The demo has to hide fan-out inside an opaque activity:

```ts
.activity('startCaseGenerationRuns', {
  input: ({ loadCurriculumContext, generateScenarios }) => ({
    curriculumId: loadCurriculumContext.curriculumId,
    defaultCaseKind: loadCurriculumContext.defaultCaseKind,
    specsWithScenarios: generateScenarios.specsWithScenarios,
  }),
  output: t.object({
    caseRuns: t.array(t.object({ runId: t.string(), caseId: t.string() })),
  }),
})
```

This prevents the workflow runtime from tracking child runs, cancellation,
partial failures, concurrency, and resume safety.

### Requested API

```ts
.mapWorkflow('caseRuns', {
  items: ({ generateScenarios }) => generateScenarios.specsWithScenarios,
  workflow: caseGenerationWorkflow,
  concurrency: 20,
  input: ({ item, loadCurriculumContext }) => ({
    scenario: item.scenario,
    curriculumId: loadCurriculumContext.curriculumId,
    kind: loadCurriculumContext.defaultCaseKind,
    dreyfusLevels: item.dreyfusLevels,
  }),
  idempotency: ({ item, loadCurriculumContext }) => [
    'case-generation',
    loadCurriculumContext.curriculumId,
    item.id,
  ],
  wait: 'all',
  failure: 'fail-fast',
  cancellation: 'propagate',
})
```

Requirements:

- Checkpoint child run IDs before/with child start.
- Resume without duplicate child runs.
- Support `start-only`, `wait-all`, and `wait-settled`.
- Preserve parent-child relation for list/query/UI.
- Support concurrency limits.
- Propagate cancellation by default, with detach option.

## Mismatch 3: Branch Output Narrowing

### Current Jobs

Case generation branches by `kind`. Obstetrics content returns extra
`obstetricsData`, later required by obstetrics question generation:

```ts
switch (input.kind) {
  case CaseKind.OBSTETRICS: {
    const job = await jobManager.add(obstetricsCaseContentGenerationJob, ...)
    const result = await job.waitResult()
    return {
      kind: result.kind,
      content: result.content,
      obstetricsData: result.data,
      review: result.review,
      contentUsage: result.usage,
    }
  }
}
```

### Current Workflow Draft

The branch must declare one common output:

```ts
.branch('content', {
  select: ({ input }): 'outpatient' | 'obstetrics' => input.kind,
  output: generatedContentSchema,
  cases: ({ workflow }) => ({
    outpatient: workflow(outpatientCaseContentWorkflow, ...),
    obstetrics: workflow(obstetricsCaseContentWorkflow, ...),
  }),
})
```

If `generatedContentSchema` does not include `obstetricsData`, the next branch
cannot access it. If it does include `obstetricsData`, outpatient output gets
irrelevant optional fields.

### Requested API

Support discriminated union branch outputs:

```ts
.branch('content', {
  select: ({ input }) => input.kind,
  cases: ({ workflow }) => ({
    outpatient: workflow(outpatientCaseContentWorkflow, ...),
    obstetrics: workflow(obstetricsCaseContentWorkflow, ...),
  }),
})
.branch('questions', {
  select: ({ content }) => content.kind,
  cases: ({ workflow }) => ({
    outpatient: workflow(outpatientQuestionWorkflow, {
      input: ({ content }) => ({ content: content.content }),
    }),
    obstetrics: workflow(obstetricsQuestionWorkflow, {
      input: ({ content }) => ({
        obstetricsData: content.obstetricsData,
      }),
    }),
  }),
})
```

Requirements:

- Branch output should infer union of case outputs when `output` omitted.
- Later branches should narrow by discriminant.
- Explicit common `output` should still be available when convergence is wanted.

## Mismatch 4: Progress And Events

### Current Jobs

Long-running steps mutate progress and manually save checkpoints:

```ts
for (let page = 0; page < totalPages; page++) {
  const { output, steps } = await generateText(...)
  usages.push(calculateUsage({ steps }))
  allSpecs.push(...output.specs)
  await saveJobProgress()
}
```

Scenario generation also needs per-item and per-batch progress:

```ts
for (const specChunk of chunk(remainingSpecs, 25)) {
  await Promise.all(specChunk.map(async (spec) => ...))
  await saveJobProgress()
}
```

### Current Workflow Draft

No public progress/event surface exists in the contract API, so this becomes
hidden inside activities or encoded into activity output.

### Requested API

Activity/workflow handlers need a typed progress and event context:

```ts
activity({
  input,
  output,
  progress: t.object({
    page: t.number(),
    totalPages: t.number(),
    generatedSpecs: t.number(),
  }),
  events: {
    specPageGenerated: t.object({ page: t.number(), count: t.number() }),
    usageRecorded: usageSchema,
  },
  handler: async ({ progress, events }, input) => {
    await progress.set({ page: 1, totalPages: 4, generatedSpecs: 25 })
    await events.emit('specPageGenerated', { page: 1, count: 25 })
  },
})
```

Client side:

```ts
client.watchRun(curriculumGenerationWorkflow, runId, {
  events: true,
  progress: true,
})
```

Requirements:

- Progress is queryable without loading raw output.
- Events form a timeline for dashboard/debugging.
- Progress/events work for child workflows and mapped children.
- Progress schema is part of public contract.

## Mismatch 5: Derived Workflow Context

### Current Jobs

Jobs have a `data` callback for shared execution context:

```ts
n.job({
  input,
  output,
  progress,
  dependencies: { db: Database, generationModelConfigService },
  data: async ({ db, generationModelConfigService }, input, progress) => {
    const curriculum = await db.query.CurriculumTable.findFirst(...)
    return {
      usages: progress.usages,
      curriculumId: curriculum.id,
      defaultCaseKind: curriculum.defaultCaseKind,
      model: await generationModelConfigService.resolveCaseGenerationModels(),
    }
  },
})
```

### Current Workflow Draft

The demo uses an activity:

```ts
.activity('loadCurriculumContext', {
  input: ({ input }) => ({ curriculum: input.curriculum }),
  output: t.object({
    curriculumId: t.string(),
    defaultCaseKind: caseKindSchema,
  }),
})
```

This is acceptable when context is durable workflow state. It is awkward when
context is runtime-only, such as model clients or config.

### Requested API

Consider explicit workflow context, with clear durability rules:

```ts
defineWorkflow({ name, input, output }).context({
  dependencies: { db: Database, modelConfig: ModelConfig },
  resolve: async ({ db, modelConfig }, { input }) => ({
    curriculum: await db.curriculum.find(input.curriculum),
    models: await modelConfig.resolveCaseGenerationModels(),
  }),
  durable: {
    curriculumId: ({ curriculum }) => curriculum.id,
    defaultCaseKind: ({ curriculum }) => curriculum.defaultCaseKind,
  },
})
```

Requirements:

- Make deterministic/durable fields explicit.
- Keep non-durable runtime helpers out of workflow history.
- Avoid forcing all shared data into activity output.

## Mismatch 6: Child Start/Wait Policy

### Current Jobs

Case generation waits on child jobs:

```ts
const job = await jobManager.add(outpatientCaseContentGenerationJob, input)
const result = await job.waitResult()
```

Curriculum generation starts child case jobs and does not wait for all outputs:

```ts
await jobManager.add(caseGenerationJob, input)
```

### Current Workflow Draft

Child workflow node implies a single behavior, but the needed behavior differs:

- start and wait
- start only
- wait all
- wait settled
- detach
- propagate cancellation
- tolerate partial failure

### Requested API

```ts
.workflow('content', outpatientCaseContentWorkflow, {
  input,
  mode: 'start-and-wait',
  cancellation: 'propagate',
})

.mapWorkflow('caseRuns', {
  workflow: caseGenerationWorkflow,
  items,
  mode: 'start-only',
  cancellation: 'detach',
})
```

Requirements:

- Policy is visible in workflow definition.
- Runtime can expose child links regardless of wait mode.
- Failure/cancellation policy is explicit.

## Mismatch 7: Query/Watch API For Product UI

### Current Jobs

Generated job router exposes basic `list/get/retry/cancel/remove`, but real UI
needs richer filtering and progress. Casenetwork dashboard ends up polling raw
job data and deriving progress from `stepIndex`.

### Current Workflow Runtime Slice

There is now a small concrete server-side runtime client. It wraps low-level
start helpers and snapshot reads, so product UI concerns remain unaddressed:

```ts
const runtime = createInMemoryWorkflowRuntime()
const client = createWorkflowRuntimeClient({
  ...runtime,
  container,
  workflows: [caseGenerationImpl],
  tasks: [generateEmbeddingImpl],
})

await client.start(caseGenerationWorkflow, input)
await client.start(generateEmbeddingTask, input)
await client.get(runId)
```

Lower-level runtime entrypoints still exist:

```ts
startWorkflowRun({ workflow, input, store, runCoordinationExecutor })
startTaskRun({ task, input, store, runCoordinationExecutor, attemptExecutor })
```

### Requested API

```ts
client.listRuns(caseGenerationWorkflow, {
  status: ['running', 'failed'],
  tags: { curriculumId, kind: 'obstetrics' },
  parentRunId,
  createdAt: { gte, lt },
  limit: 50,
  cursor,
})

client.getRun(caseGenerationWorkflow, runId, {
  include: ['progress', 'children', 'events'],
})

client.watchRun(caseGenerationWorkflow, runId)
```

Requirements:

- Filter by tags, parent run, status, time range.
- Cursor pagination.
- Include child runs.
- Include typed progress.
- Stream status/progress/event updates.

## Acceptance Criteria

- Casenetwork case-generation workflow can be represented without hiding child
  workflows inside opaque activities.
- Casenetwork curriculum-generation workflow can fan out to N child case
  workflows with concurrency and duplicate-safe resume.
- Parallel section generation is represented as first-class workflow graph.
- Branches can either converge to explicit common output or preserve
  discriminated union output.
- Progress/events are public contract and query/watch surface, not raw job
  internals.
- Workflow run listing is strong enough for a dashboard without custom SQL
  mirrors.

## Related Demo

See `packages/workflows/tests/examples/casenetwork-complex-workflow.demo.ts` for a
type-level reproduction attempt and inline comments where the current API has
to compromise.
