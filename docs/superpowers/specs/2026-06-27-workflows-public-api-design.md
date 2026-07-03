# Workflows Public API Design

## Context

`@nmtjs/workflows` should replace the overloaded `jobs` model with explicit
background execution primitives:

- `task`: one isolated background unit
- `workflow`: durable orchestration of primitive leaves and bounded
  orchestration nodes
- `activity`: workflow-local side-effecting operation

This spec defines the intended user-facing API shape. The durable runtime is
Postgres-first, while root declarations and implementations stay import-light.

## Goals

- Separate declaration imports from worker implementation imports.
- Make simple background work simple.
- Make orchestration semantics visible instead of hiding them behind
  `job.step()`.
- Keep public contracts independent from BullMQ, Redis, Valkey, SQL, and
  internal command-runner details.
- Use explicit node names instead of flat object merging.
- Keep workflow declarations introspectable without importing implementations.
- Make idempotency and branch selection first-class. Retry and cancellation
  policy metadata can exist in contracts, but scheduling/propagation semantics
  are not implemented in the current runtime slice.

## Non-Goals

- Do not define final SQL tables.
- Do not define final adapter APIs.
- Do not support arbitrary Temporal-style deterministic replay in the first API.
- Do not expose reusable non-startable activity declarations in the first API.
- Do not expose signals, queries, timers, or watches in the first API.
- Do not expose progress/timeline events in the first API.
- Do not expose fine-grained static data dependency introspection in the first
  API. V1 graph introspection is structural: node order, node kind, schemas,
  runnable targets, and orchestration boundaries.
- Do not migrate `@nmtjs/jobs` in this spec.

## Top-Level API

Root package should expose dependency-light builders:

```ts
import { defineTask, defineWorkflow } from '@nmtjs/workflows'
```

Worker code imports implementation builders from the same root only if they do
not pull adapter modules:

```ts
import { implementTask, implementWorkflow } from '@nmtjs/workflows'
```

Postgres runtime integration stays behind explicit subpaths:

```ts
import { createPostgresWorkflowRuntime } from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
```

The root contract/implementation API must stay import-light.

## V1 Surface

The first public API should be small:

- `defineTask`
- `implementTask`
- `defineWorkflow`
- `implementWorkflow`
- primitive leaf nodes: `activity`, `task`, `workflow`
- orchestration nodes: `branch`, `parallel`, `mapTask`, `mapWorkflow`
- runtime start helpers behind `@nmtjs/workflows/runtime`: `startWorkflowRun`,
  `startTaskRun`
- runtime client behind `@nmtjs/workflows/runtime`:
  `createWorkflowRuntimeClient`
- Postgres runtime: `createPostgresWorkflowRuntime`
- reserved app-facing client commands: `cancel`, `retry`, `watch`
- public graph types: `WorkflowNode`, `WorkflowActivityNode`,
  `WorkflowTaskNode`, `WorkflowChildWorkflowNode`, `WorkflowBranchNode`,
  `WorkflowParallelNode`, `WorkflowMapTaskNode`, `WorkflowMapWorkflowNode`

Future concepts should remain design-compatible but not part of the first API
promise.

Current implementation note: there is a small server-side runtime client,
`createWorkflowRuntimeClient`, which wraps `startWorkflowRun`, `startTaskRun`,
`store.loadRunSnapshot`, and `store.listRuns`. It is exported from the runtime
subpath, not the root package. It is not the final application-facing client.
Runtime callers may still use start helpers, worker loops, store interfaces, and
executor interfaces directly from `@nmtjs/workflows/runtime` while the runtime is
still being collapsed around Postgres. `createInMemoryWorkflowRuntime` may remain
as a narrow local/test helper, not as a second production backend.

## Tasks

A task is one retryable background operation. It has no child workflow graph.
It can be started directly by a client, API, or scheduler. It can also be used
as a workflow node.

Declaration:

```ts
export const deleteStorageObject = defineTask({
  name: 'storage.delete-object',
  input: t.object({ bucket: t.string(), key: t.string() }),
  output: t.object({ deleted: t.boolean() }),
  retry: { attempts: 3, backoff: 'exponential' },
  timeout: '2m',
})
```

Implementation:

```ts
export const deleteStorageObjectImpl = implementTask(deleteStorageObject, {
  dependencies: { storage },
  idempotency: (_ctx, input) => [
    'storage.delete-object',
    input.bucket,
    input.key,
  ],
  async handler(ctx, input) {
    await ctx.storage.delete(input.bucket, input.key)
    return { deleted: true }
  },
})
```

Rules:

- Task declaration is safe to import anywhere.
- Task implementation may import app services.
- Task execution is at-least-once.
- Idempotency is declared on the task implementation because it is executable
  runtime behavior.
- A task used inside a workflow keeps its public contract and starts a durable
  child task run linked to the parent workflow node.
- Attempts are internal retry/lease records for a task run. Public task APIs and
  map outputs should expose task run IDs, not attempt IDs.

## Activities

An activity is a workflow-local side-effecting node. It is not independently
startable, listable, or reusable by contract in v1.

Inline activity declaration:

```ts
.activity('generateContent', {
  input: GenerateCaseContentInput,
  output: GenerateCaseContentOutput,
  retry: { attempts: 3, backoff: 'exponential' },
  timeout: '15m',
})
```

Rules:

- Activity handlers are side-effect boundaries.
- Activities are owned by one workflow implementation.
- Reusable, public operations should be `task`s.
- Public `defineActivity` can be added later only if reusable non-startable
  operations prove useful.

## Workflows

A workflow is a durable coordinator. It should be modeled as a typed declarative
graph/state machine, not arbitrary replayed JS.

Declaration:

```ts
export const caseGeneration = defineWorkflow({
  name: 'case-generation',
  input: CaseGenerationInput,
  output: CaseGenerationOutput,
  retention: '30d',
})
  .activity('content', {
    input: GenerateCaseContentInput,
    output: GenerateCaseContentOutput,
    retry: { attempts: 3, backoff: 'exponential' },
  })
  .branch('caseContent', {
    output: CaseContentOutput,
    cases: ({ activity, workflow }) => ({
      outpatient: workflow(outpatientCaseWorkflow),
      obstetrics: workflow(obstetricsCaseWorkflow),
      fallback: activity({
        input: FallbackCaseInput,
        output: CaseContentOutput,
      }),
    }),
  })
  .parallel('postProcessing', ({ task, activity }) => ({
    embedding: task(generateEmbedding),
    audit: activity({
      input: CaseAuditInput,
      output: CaseAuditOutput,
    }),
  }))
  .activity('saveCase', {
    input: SaveCaseInput,
    output: SaveCaseOutput,
  })
  .build()
```

Implementation:

```ts
export const caseGenerationImpl = implementWorkflow(caseGeneration, {
  dependencies: { clock, logger },
  idempotency: (_ctx, workflowInput) => [
    'case-generation',
    workflowInput.curriculumId,
    workflowInput.scenario,
  ],
  tags: (_ctx, workflowInput) => ({
    curriculumId: workflowInput.curriculumId,
    scenario: workflowInput.scenario,
  }),
})
  .content(
    {
      dependencies: { llm, usage },
      handler: generateCaseContent,
    },
    { input: (_ctx, _outputs, workflowInput) => workflowInput },
  )
  .caseContent({
    select: (
      _ctx,
      _outputs,
      workflowInput,
    ): 'outpatient' | 'obstetrics' | 'fallback' => workflowInput.kind,
    cases: ({ activity, workflow }) => ({
      outpatient: workflow(outpatientCaseWorkflow, {
        input: (_ctx, _outputs, workflowInput) => ({
          scenario: workflowInput.scenario,
        }),
      }),
      obstetrics: workflow(obstetricsCaseWorkflow, {
        input: (_ctx, _outputs, workflowInput) => ({
          scenario: workflowInput.scenario,
        }),
      }),
      fallback: activity(generateFallbackCase, {
        input: (_ctx, { content }) => ({ text: content.text }),
      }),
    }),
  })
  .postProcessing(({ task, activity }) => ({
    embedding: task(generateEmbedding, {
      input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
    }),
    audit: activity(auditCaseContent, {
      input: (_ctx, { caseContent }) => ({ text: caseContent.text }),
    }),
  }))
  .saveCase(
    {
      dependencies: { db },
      handler: saveCase,
    },
    {
      input: (_ctx, { caseContent, postProcessing }, workflowInput) => ({
        curriculumId: workflowInput.curriculumId,
        content: caseContent.text,
        embeddingId: postProcessing.embedding.id,
      }),
      idempotency: (_ctx, _outputs, workflowInput) => [
        'save-case',
        workflowInput.curriculumId,
      ],
    },
  )
  .finish((_ctx, { saveCase }) => ({ caseId: saveCase.caseId }))
```

Branch methods may also accept a callback when an inline branch activity needs
its own dependencies:

```ts
.caseContent(({ fallback }) => ({
  fallback: fallback({
    dependencies: { llm },
    handler: generateFallbackCase,
  }),
  outpatient: outpatientCaseWorkflow,
  obstetrics: obstetricsCaseWorkflow,
}))
```

Rules:

- Workflow declarations contain schemas, node names, and referenced task/workflow
  contracts. They must not contain runtime mapping functions such as `input`,
  `select`, `items`, idempotency/tag callbacks, or return-output mappers.
- Workflow implementations own runtime mapping functions. Handler definitions
  stay reusable because mappers are passed as separate workflow options, not
  merged into handler objects.
- Workflow implementations own idempotency and tag callbacks because those are
  executable runtime behavior and may use implementation dependencies.
- Node names are explicit and stable.
- Node outputs are addressed by node name.
- Node names become both type-level mapper keys and runtime output keys.
- Runtime must reject duplicate node names.
- Runtime must reject node names that are not identifier-like strings.
- Runtime must not merge step outputs with `Object.assign`.
- Workflow declaration declares orchestration.
- Workflow implementation binds handlers for inline activities in declaration
  order.
- Task and child workflow nodes appear in the implementation chain as explicit
  delegation acknowledgements.
- Task and child workflow nodes are acknowledged by passing the same task or
  workflow declaration, not an implementation.
- Branch and parallel implementation methods require every case. Inline activity
  cases bind handlers; task and workflow cases assign the same task/workflow
  declaration.
- Tasks and child workflows are referenced by contract and implemented
  separately, possibly by different workers.
- Handler dependencies use the common `@nmtjs/core` handler/dependable pattern:
  `{ dependencies, handler }` infers `ctx` from dependency injectables without an
  extra generic helper.

## Node Model

V1 splits nodes into primitive leaves and orchestration nodes.

Primitive leaves:

- `activity(name, options)`
- `task(name, task, options?)`
- `workflow(name, workflow, options?)`

Orchestration nodes:

- `branch(name, options)`
- `parallel(name, cases)`
- `mapTask(name, task, options)`
- `mapWorkflow(name, workflow, options)`

`branch` and `parallel` compose only primitive leaves in v1. They cannot contain
nested `branch`, `parallel`, `mapTask`, or `mapWorkflow` cases. If a branch or
parallel case needs complex orchestration, model that work as a child workflow
and use a `workflow(...)` leaf.

Each node should have:

- stable name
- output type
- retry policy, where meaningful
- timeout, where meaningful
- structural orchestration metadata, where meaningful

The public graph type must preserve the same declaration metadata present at
runtime. `WorkflowNode` is a discriminated union:

```ts
type WorkflowNode =
  | WorkflowActivityNode
  | WorkflowTaskNode
  | WorkflowChildWorkflowNode
  | WorkflowBranchNode
```

Required public metadata:

- activity node: `kind`, `name`, `input`, `output`, `retry`, `timeout`
- task node: `kind`, `name`, `task`, `retry`, `timeout`
- child workflow node: `kind`, `name`, `workflow`, `cancellation`
- branch node: `kind`, `name`, optional `output`, `cases`
- parallel node: `kind`, `name`, `cases`
- map task node: `kind`, `name`, `task`, `item`, `mode`, `concurrency`
- map workflow node: `kind`, `name`, `workflow`, `item`, `mode`,
  `concurrency`, `cancellation`

Rules:

- Declaration graph introspection must not require importing workflow
  implementation.
- Declaration graph introspection is intentionally structural. It exposes
  sequence, branches, parallel groups, fan-out nodes, schemas, and runnable
  targets.
- Runtime dataflow functions (`input`, `select`, `items`, `finish`) belong to
  implementation and are not part of the declaration graph.
- Fine-grained static dataflow such as "this mapper reads only
  `dedupeSpecs.specs`" is out of scope for v1. If needed later, add explicit
  implementation metadata such as `uses: ['dedupeSpecs']`; do not move
  executable mappers back into declarations.
- Runtime node objects and public node types must describe the same contract
  shape.
- Implementation code should not need `any` to know whether a node is activity,
  task, child workflow, or branch.
- Task and child workflow nodes must retain their exact target contract types.

Node names should be restricted to identifier-like strings:

```txt
/^[a-zA-Z_$][a-zA-Z0-9_$]*$/
```

That keeps mapper output access ergonomic and avoids runtime/type naming
mismatches.

Node input schemas belong to the contract:

```ts
.activity('saveCase', {
  input: SaveCaseInput,
  output: SaveCaseOutput,
})
```

Runtime input mapping belongs to the implementation:

```ts
.saveCase(saveCase, {
  input: (_ctx, { content }, workflowInput) => ({
    curriculumId: workflowInput.curriculumId,
    content: content.text,
  }),
})
```

## Node Output Scope

Every completed node writes one output value under its node name. The workflow
builder carries those names forward in its type state, and the runtime uses the
same names as persisted output keys.

Example:

```ts
defineWorkflow({
  name: 'case-generation',
  input: CaseGenerationInput,
})
  .activity('generateContent', {
    input: GenerateContentInput,
    output: GenerateContentOutput,
  })
  .task('embedding', generateEmbedding)
```

After `.activity('generateContent', ...)`, later implementation mapper
functions receive separate arguments:

```ts
type WorkflowInput = CaseGenerationInput

type Outputs = {
  generateContent: GenerateContentOutput
}
```

Mappers use this order:

```ts
input: (ctx, outputs, workflowInput) => NodeInput
select: (ctx, outputs, workflowInput) => CaseKey
items: (ctx, outputs, workflowInput) => Item[]
finish: (ctx, outputs, workflowInput) => WorkflowOutput
```

Map item input receives the item and index after outputs:

```ts
input: (ctx, outputs, item, workflowInput, index) => ChildInput
```

`ctx` is workflow-level dependency context. It is not durable workflow state.
Node handlers still use their own local handler dependencies.

At runtime, the persisted output map uses the same key:

```ts
{
  generateContent: { text: '...', usage: ... }
}
```

Before running a node, runtime passes decoded workflow input and completed node
outputs separately:

```ts
mapper(workflowCtx, completedNodeOutputs, decodedWorkflowInput)
```

Rules:

- Mapper outputs include only completed upstream node outputs.
- Workflow input is passed as its own argument.
- A node cannot read its own output.
- Runtime and type-level scopes must use the same node names.
- Duplicate node names are invalid.

## Branches

Branches are part of v1 because real workflows need typed conditional paths.
Keep the first shape narrow: a selector chooses one execution target by key.
Branch cases may run an inline activity, a task, or a child workflow.
They may not contain nested orchestration nodes in v1.

Branch API:

```ts
.branch('caseContent', {
  cases: ({ workflow, task, activity }) => ({
    outpatient: workflow(outpatientCaseWorkflow),
    obstetrics: workflow(obstetricsCaseWorkflow),
    fallback: activity({
      input: FallbackCaseInput,
      output: CaseContentOutput,
    }),
  }),
})
```

If `output` is omitted, branch node output is inferred as the union of case
outputs:

```ts
content: OutpatientCaseOutput | ObstetricsCaseOutput | FallbackCaseOutput
```

If `output` is present, every case output must be assignable to that common
shape:

```ts
.branch('caseContent', {
  output: CaseContentOutput,
  cases: ...
})
```

Rules:

- `cases` is a definition-time builder callback.
- Case helpers are scoped to branch case construction.
- Case targets are only `workflow`, `task`, and `activity`.
- Branch cases are discriminated by `kind`.
- Activity cases carry inline activity declaration metadata.
- Task cases carry required `target` pointing at the task declaration.
- Workflow cases carry required `target` pointing at the child workflow
  declaration.
- Omitted `output` preserves case-specific payloads for downstream narrowing.
- Present `output` converges cases to one common shape.
- Implementation `select` return type defines the runtime case key.
- Implementation `cases` must exactly cover the declaration cases.
- Extra case keys are invalid.
- Missing case keys are invalid.
- If `select` returns plain `string`, exact type coverage is impossible; users
  should narrow the selector return type to a literal union.
- Runtime still rejects selector values not present in cases.
- Branch output can either infer a union or converge to an explicit common
  output.
- If explicit `output` is present, each case output must satisfy branch
  `output`.
- Branch output is stored under the branch node name.
- Branch is not a subgraph in v1; it selects one execution target.
- If a branch case needs a subgraph, use a child workflow leaf.

Public branch case shape:

```ts
type BranchCaseDefinition =
  | {
      kind: 'activity'
      input: Schema
      output: Schema
      retry?: RetryPolicy
      timeout?: DurationString
    }
  | {
      kind: 'task'
      target: TaskDefinition
      retry?: RetryPolicy
      timeout?: DurationString
    }
  | {
      kind: 'workflow'
      target: WorkflowDefinition
      cancellation?: CancellationPolicy
    }
```

## Parallel

Parallel nodes run a static set of named primitive leaves concurrently. They are
for work known at declaration time, such as generating fixed case-content
sections from the same reviewed snapshot.

API:

```ts
.parallel('sections', ({ activity, task, workflow }) => ({
  patientBackground: activity({
    input: SectionInput,
    output: PatientBackgroundOutput,
  }),
  treatmentPlan: activity({
    input: SectionInput,
    output: TreatmentPlanOutput,
  }),
  rubric: workflow(rubricWorkflow),
  embedding: task(generateEmbedding),
})
```

Rules:

- Parallel cases are primitive leaves only: activity, task, or child workflow.
- All parallel siblings receive the same upstream output snapshot.
- Each sibling keeps its own timeout, idempotency, and failure state. Retry
  scheduling is planned, not implemented in the current runtime slice.
- Output is stored under the parallel node name as an object keyed by case name.
- Inline activity cases are implemented in the parent workflow implementation.
- Task and workflow cases are acknowledged with declarations.
- No nested orchestration nodes in v1. Use a child workflow when a parallel case
  needs branch/map/parallel behavior.

Implementation:

```ts
implementWorkflow(outpatientContentWorkflow).sections(
  ({ activity, task, workflow }) => ({
    patientBackground: activity(generatePatientBackground, {
      input: (_ctx, { applyReview }) => ({
        blueprint: applyReview.revisedBlueprint,
      }),
    }),
    treatmentPlan: activity(generateTreatmentPlan, {
      input: (_ctx, { applyReview }) => ({
        blueprint: applyReview.revisedBlueprint,
      }),
    }),
    rubric: workflow(rubricWorkflow, {
      input: (_ctx, { applyReview }) => ({
        blueprint: applyReview.revisedBlueprint,
      }),
    }),
    embedding: task(generateEmbedding, {
      input: (_ctx, { applyReview }) => ({
        text: applyReview.revisedBlueprint,
      }),
    }),
  }),
)
```

## Dynamic Fan-Out

`mapTask` and `mapWorkflow` run one primitive runnable for each item produced at
runtime. They are for dynamic counts, such as one case-generation run per
generated scenario or one embedding task per saved case.

Workflow fan-out:

```ts
.mapWorkflow('caseRuns', caseGenerationWorkflow, {
  item: GeneratedScenario,
  mode: 'start-only',
  concurrency: 20,
  cancellation: 'propagate',
})
```

Task fan-out:

```ts
.mapTask('embeddings', generateEmbedding, {
  item: SavedCase,
  mode: 'wait-all',
  concurrency: 50,
})
```

Modes:

- `start-only`: start every child task/workflow run and continue after child run
  IDs are checkpointed. Output is run references.
- `wait-all`: wait for every child to complete successfully. Output includes
  child outputs.
- `wait-settled`: wait for every child to reach terminal state. Output includes
  success and failure entries.

Rules:

- `mapWorkflow(name, workflow, options)` and `mapTask(name, task, options)`
  mirror the existing node grammar.
- `item` is a schema, and implementation mapper `item` type is inferred from
  that schema.
- `mode` is required for map nodes.
- Runtime checkpoints each item-to-child-run link before or with dispatch.
- Retry/resume must not create duplicate child runs for already-checkpointed
  items.
- `concurrency` limits active children for wait modes. For `start-only`,
  concurrency limits child links started per continuation pass.
- Cancellation propagation for mapped workflows is planned but not implemented
  in the current runtime slice.
- Parent implementation acknowledges map nodes with the target declaration:

  ```ts
  implementWorkflow(curriculumWorkflow)
    .caseRuns(caseGenerationWorkflow, {
      items: (_ctx, { generateScenarios }) =>
        generateScenarios.specsWithScenarios,
      input: (_ctx, _outputs, item, workflowInput) => ({
        curriculumId: workflowInput.curriculumId,
        scenario: item.scenario,
        kind: workflowInput.defaultCaseKind,
        dreyfusLevels: item.dreyfusLevels,
      }),
      idempotency: (_ctx, _outputs, item, workflowInput) => [
        'case-generation',
        workflowInput.curriculumId,
        item.id,
      ],
    })
    .embeddings(generateEmbedding, {
      items: (_ctx, { savedCases }) => savedCases.cases,
      input: (_ctx, _outputs, item) => ({
        entity: 'case',
        entityId: item.caseId,
      }),
    })
  ```

## Task Nodes

Tasks can run standalone or inside workflows.

Standalone:

```ts
await workflows.start(generateEmbedding, { text })
```

Inside workflow:

```ts
.task('embedding', generateEmbedding)
```

Rules:

- A standalone task start creates a durable task run.
- A workflow task node creates or reuses a durable child task run for the parent
  run and node name.
- Branch task cases, parallel task members, and `mapTask` items also create or
  reuse durable child task runs using structured child identity.
- Task attempts are internal to a task run. They are not the public handle for
  workflow dataflow, client APIs, or map outputs.
- Task node output is addressed by node name.
- Task nodes appear in the parent implementation chain and must be acknowledged
  with the same task declaration:

  ```ts
  .embedding(generateEmbedding, {
    input: (_ctx, { content }) => ({ text: content.text }),
  })
  ```

- Passing a different task declaration is invalid.
- Task node retry/timeout defaults come from the task declaration.
- Task node options may override retry/timeout only when the API explicitly
  allows it.
- Parent restart reuses the existing child task run ID for that task node or
  composite child identity. Retry scheduling is future runtime work.
- The node output is the child task run output.

## Child Workflow Nodes

Workflow nodes start another workflow run and wait for its output. Task nodes and
workflow nodes share the same parent-child durability model: both are child runs;
workflow nodes coordinate graphs, while task nodes execute one handler.

Top-level workflow node:

```ts
.workflow('rubric', rubricGeneration, {
  cancellation: 'propagate',
})
```

Branch workflow case:

```ts
.branch('caseContent', {
  output: CaseContentOutput,
  cases: ({ workflow }) => ({
    outpatient: workflow(outpatientCaseWorkflow),
    obstetrics: workflow(obstetricsCaseWorkflow),
  }),
})
```

Rules:

- Parent persists the child link before child execution is dispatched.
- Child workflow nodes appear in the parent implementation chain and must be
  acknowledged with the same child workflow declaration:

  ```ts
  .rubric(rubricGeneration, {
    input: (_ctx, { caseContent }) => ({ content: caseContent.text }),
  })
  ```

- Passing a different workflow declaration is invalid.
- Parent restart reuses the existing child run ID for that workflow node.
- Parent waits for child terminal state.
- Child output is encoded by the child workflow output contract.
- The node output is the child workflow output.
- Parent cancellation propagation is planned but not implemented in the current
  runtime slice.
- Runtime rejects duplicate child-start attempts for the same parent node unless
  they resolve to the existing persisted child run.

## Implementation Boundaries

`implementWorkflow(parentWorkflow)` mirrors declaration order, but it does not
bind external runnable implementations.

Rules:

- Inline activity nodes are implemented with handlers.
- Task nodes are acknowledged with task declarations.
- Child workflow nodes are acknowledged with workflow declarations.
- Branch methods include every case. Activity cases provide handlers; task and
  workflow cases provide declarations.
- Parent workflow implementations must not import child workflow or task
  implementations just to satisfy the chain.
- Worker/runtime assembly validates that referenced task and child workflow
  declarations are routeable to an implementation in the current deployment.

This keeps distributed workers possible:

```ts
runWorkflowWorker({
  workflows: [caseGenerationImpl],
  // store, executors, container, workerId...
})

runWorkflowWorker({
  workflows: [rubricGenerationImpl],
  // store, executors, container, workerId...
})

runTaskWorker({
  tasks: [generateEmbeddingImpl],
  // store, executors, container, workerId...
})
```

## Status Model

Public statuses:

```ts
type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
```

Rules:

- Statuses are Neemata workflow statuses, not adapter statuses.
- `cancelled` is terminal.
- `cancelling` is non-terminal and propagates to active nodes/children.
- Retry state should be visible in node state, not necessarily top-level run
  status.
- Public `WorkflowStatus` includes `waiting` to stay aligned with
  `RuntimeRunStatus`.

## Runtime Client

The current concrete client is intentionally small and server-side. It operates
on task/workflow declarations and runtime infrastructure:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import { createPostgresWorkflowRuntime } from '@nmtjs/workflows/postgres'

const runtime = createPostgresWorkflowRuntime({ connection })
const workflows = createWorkflowRuntimeClient({
  ...runtime,
  container,
  workflows: [caseGenerationImpl],
  tasks: [generateEmbeddingImpl],
})

await workflows.start(generateEmbedding, input, options)
await workflows.start(caseGeneration, input, options)
await workflows.get(runId)
await workflows.list({ status: 'running' })
```

Rules:

- `start` accepts task or workflow declarations, not implementations.
- Registered implementations are optional but used when present to compute
  implementation-owned tags and idempotency keys.
- `get(runId)` returns the current runtime snapshot shape.
- The runtime client must not expose queue IDs or adapter-native job objects.
- `cancel`, `retry`, `watch`, event streams, and typed public run projections
  remain future app-facing client work.

## Idempotency

Idempotency should exist at three levels:

- task run start
- workflow run start
- activity attempt execution
- child task/workflow run execution from workflow nodes and composite children

V1 idempotency callbacks return only a serializable key:

```ts
idempotency: (_ctx, input) => ['case-generation', input.curriculumId]
```

Initial duplicate behavior is runtime-defined: same idempotency key with the
same durable input returns the existing run/attempt/link; same key with
different durable input fails as an explicit conflict. Named conflict policies
can be added later when the store/client contract carries them end to end.

Rules:

- Idempotency keys must be serializable.
- Store layer owns uniqueness enforcement.
- API should not imply exactly-once execution.
- Idempotency callbacks belong to implementations, not declarations. Contracts
  stay structural and import-safe.
- Current runtime evaluates implementation-owned idempotency callbacks for
  explicit starts, activity/task attempts, and child task/workflow runs, then
  persists or dispatches the computed key.

## Retry And Timeout Policy

Retry policy can exist on:

- task
- activity
- whole workflow, if explicitly supported later

Timeout policy can exist on:

- task
- activity

Rules:

- Activity retry retries the activity node.
- Workflow retry should be a separate semantic, not hidden behind activity
  retry.
- V1 contracts can declare task/activity retry policy metadata, but current
  runtime does not schedule retries yet. Workflow-level retry is future.
- Retry override input should be explicit client behavior, not automatic.

## Future Extension Points

These concepts should remain possible but are not v1 API:

- reusable `defineActivity`
- signals
- queries
- typed workflow events, timeline events, progress records, usage timeline, and
  subscriptions
- timers
- watch/subscribe client APIs
- workflow-level retry
- imperative helpers such as `ctx.child(workflow).startAndWait(input)`
- optional fine-grained implementation dataflow metadata, if structural graph
  introspection is not enough for debugging or dashboards

## Import Guarantees

These imports must remain light:

```ts
import { defineWorkflow } from '@nmtjs/workflows'
import type { WorkflowRun } from '@nmtjs/workflows'
```

These imports may require optional peer dependencies:

```ts
import { createPostgresWorkflowRuntime } from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
```

## Open Questions

- None for the v1 public API shape in this spec.

## Acceptance Criteria

- A user can declare a workflow without importing its implementation.
- A user can implement a workflow without importing an adapter.
- Runtime can start workflow and task runs using declarations through
  `createWorkflowRuntimeClient`.
- A full app-facing cancel/retry/watch client remains future work.
- Activity, task, workflow, and branch outputs are addressed by explicit node
  names.
- Branch cases exactly cover the selector return union.
- Parallel cases expose a structured output object under the parallel node name.
- Dynamic child workflows and tasks are represented with `mapWorkflow` and
  `mapTask`, not hidden inside opaque activities.
- Workflow implementations explicitly acknowledge task and child workflow nodes
  with declarations, without importing their implementations.
- Public contract/implementation API avoids BullMQ, Redis, Valkey, SQL, and
  queue-native vocabulary.
- Postgres runtime details live behind `@nmtjs/workflows/postgres` subpaths.
