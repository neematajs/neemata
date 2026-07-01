import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createWorkflowRuntimeRegistry,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'

import type {
  AttemptCommand,
  AttemptExecutor,
  CompleteMapItemParams,
  ContinueRunCommand,
  ContinueWorkflowRunResult,
  CreateRunInput,
  EnsureChildRunParams,
  EnsureChildRunResult,
  EnsureChildWorkflowRunParams,
  EnsureChildWorkflowRunResult,
  EnsureMapItemsParams,
  EnsureMapItemsResult,
  EnsureNodeAttemptParams,
  EnsureNodeAttemptResult,
  FailMapItemParams,
  InMemoryWorkflowRuntime,
  ListRunsFilter,
  ListRunsResult,
  LoadNodeChildrenParams,
  NodeChildIdentity,
  NodeChildrenSnapshot,
  RunCoordinationExecutor,
  RunKind,
  RunnableRun,
  SelectNodeCaseParams,
  StoredAttempt,
  StoredChildLink,
  StoredMapItem,
  StoredNode,
  StoredRun,
  StartWorkflowRunInput,
  TaskRun,
  WaitNodeParams,
  WorkerCommandResult,
  WorkerLoopOptions,
  WorkerLoopResult,
  WorkflowRuntimeAdapter,
  WorkflowStatus,
  WorkflowStore,
} from '../src/index.ts'
import type {
  SelectNodeCaseParams as RuntimeSelectNodeCaseParams,
} from '../src/runtime/index.ts'

type SemanticWorkflowStoreMethods = {
  listRuns(params?: ListRunsFilter): Promise<ListRunsResult>
  selectNodeCase(params: SelectNodeCaseParams): Promise<StoredNode | undefined>
  ensureNodeAttempt(
    params: EnsureNodeAttemptParams,
  ): Promise<EnsureNodeAttemptResult>
  ensureChildWorkflowRun(
    params: EnsureChildWorkflowRunParams,
  ): Promise<EnsureChildWorkflowRunResult>
  ensureChildRun(params: EnsureChildRunParams): Promise<EnsureChildRunResult>
  ensureMapItems(params: EnsureMapItemsParams): Promise<EnsureMapItemsResult>
  completeMapItem(
    params: CompleteMapItemParams,
  ): Promise<StoredMapItem | undefined>
  failMapItem(params: FailMapItemParams): Promise<StoredMapItem | undefined>
  waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>
  loadNodeChildren(
    params: LoadNodeChildrenParams,
  ): Promise<NodeChildrenSnapshot>
}

type OptionalKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? K : never
}[keyof T]

type WorkflowStoreWithRequiredSemanticMethods = Omit<
  WorkflowStore,
  keyof SemanticWorkflowStoreMethods
> &
  SemanticWorkflowStoreMethods

describe('workflow runtime interfaces', () => {
  it('exports adapter-free runtime contracts from the root package', () => {
    expectTypeOf<ContinueRunCommand>().toMatchTypeOf<{
      kind: 'continueRun'
      runId: string
      workflowName: string
    }>()

    expectTypeOf<AttemptCommand>().toMatchTypeOf<{
      attemptId: string
      leaseToken: string
      workflowName: string
      runId: string
      nodeName: string
    }>()

    expectTypeOf<RunCoordinationExecutor>().toHaveProperty('enqueue')
    expectTypeOf<AttemptExecutor>().toHaveProperty('dispatchActivity')
    expectTypeOf<WorkflowStore>().toHaveProperty('createRun')
    expectTypeOf<WorkflowRuntimeAdapter>().toMatchTypeOf<{
      store: WorkflowStore
      runCoordinationExecutor: RunCoordinationExecutor
      attemptExecutor: AttemptExecutor
    }>()
    expectTypeOf<InMemoryWorkflowRuntime>().toMatchTypeOf<
      WorkflowRuntimeAdapter
    >()
    expectTypeOf<CreateRunInput>().toMatchTypeOf<{
      kind?: RunKind
      name?: string
      workflowName: string
      taskName?: string
    }>()
    expectTypeOf<ListRunsFilter>().toMatchTypeOf<{
      kind?: RunKind
      name?: string
      status?: string | readonly string[]
      parentRunId?: string
      rootRunId?: string
      tags?: Readonly<Record<string, string>>
      input?: unknown
      limit?: number
      cursor?: string
    }>()
    expectTypeOf<ListRunsResult>().toMatchTypeOf<{
      runs: readonly StoredRun[]
      nextCursor?: string
    }>()
    expectTypeOf<StoredRun>().toHaveProperty('status')
    expectTypeOf<StoredRun>().toMatchTypeOf<{
      kind: RunKind
      name: string
      workflowName: string
      taskName?: string
    }>()
    expectTypeOf<StoredNode>().toHaveProperty('status')
    expectTypeOf<StoredAttempt>().toHaveProperty('status')
    expectTypeOf<ContinueWorkflowRunResult>().toMatchTypeOf<{
      status: 'processed' | 'busy' | 'ignored'
    }>()
    expectTypeOf<WorkerCommandResult>().toMatchTypeOf<{
      status: 'processed' | 'released'
    }>()
    expectTypeOf<WorkerLoopOptions>().toMatchTypeOf<{
      workerId: string
      concurrency?: number
      leaseMs?: number
      maxIdleClaims?: number
      signal?: AbortSignal
    }>()
    expectTypeOf<WorkerLoopResult>().toMatchTypeOf<{ processed: number }>()
    expectTypeOf<WorkflowStatus>().toEqualTypeOf<
      | 'queued'
      | 'running'
      | 'waiting'
      | 'cancelling'
      | 'cancelled'
      | 'failed'
      | 'completed'
    >()
    expectTypeOf<StartWorkflowRunInput<any>>().toMatchTypeOf<{
      workflow: { name: string }
      input: unknown
      tags?: Readonly<Record<string, string>>
      idempotencyKey?: readonly unknown[]
    }>()
    expectTypeOf<TaskRun>().toMatchTypeOf<{
      id: string
      kind: 'task'
      task: string
      status: string
    }>()
    expectTypeOf<RunnableRun>().toMatchTypeOf<
      { kind: 'task' } | { kind: 'workflow' }
    >()
  })

  it('exports semantic orchestration store contracts', () => {
    expectTypeOf<SelectNodeCaseParams>().toMatchTypeOf<{
      runId: string
      nodeName: string
      caseKey: string
    }>()
    expectTypeOf<RuntimeSelectNodeCaseParams>().toEqualTypeOf<
      SelectNodeCaseParams
    >()
    expectTypeOf<NodeChildIdentity>().toMatchTypeOf<{
      runId: string
      nodeName: string
      caseKey?: string
      memberKey?: string
      itemIndex?: number
      itemKey?: string
    }>()
    expectTypeOf<EnsureNodeAttemptParams>().toMatchTypeOf<{
      identity: NodeChildIdentity
      kind: 'activity' | 'task'
      input: unknown
    }>()
    expectTypeOf<EnsureChildWorkflowRunParams>().toMatchTypeOf<{
      identity: NodeChildIdentity
      workflowName: string
      input: unknown
      parentRunId: string
      parentNodeName: string
      rootRunId: string
    }>()
    expectTypeOf<EnsureChildRunParams>().toMatchTypeOf<{
      identity: NodeChildIdentity
      childKind: RunKind
      childName: string
      input: unknown
      parentRunId: string
      parentNodeName: string
      rootRunId: string
    }>()
    expectTypeOf<EnsureChildRunResult>().toMatchTypeOf<{
      childLink: StoredChildLink
      childRun: StoredRun
      created: boolean
    }>()
    expectTypeOf<EnsureMapItemsParams>().toMatchTypeOf<{
      runId: string
      nodeName: string
      items: readonly unknown[]
      keys?: readonly string[]
    }>()
    expectTypeOf<NodeChildrenSnapshot>().toMatchTypeOf<{
      attempts: readonly unknown[]
      childLinks: readonly unknown[]
      mapItems: readonly unknown[]
    }>()
    expectTypeOf<WaitNodeParams>().toMatchTypeOf<{
      runId: string
      nodeName: string
    }>()
    expectTypeOf<StoredChildLink>().toHaveProperty('identity')
    expectTypeOf<StoredChildLink>().toMatchTypeOf<{
      childKind: RunKind
      childName: string
      workflowName: string
      taskName?: string
    }>()
    expectTypeOf<StoredMapItem>().toHaveProperty('identity')
    expectTypeOf<WorkflowStore>().toHaveProperty('listRuns')
    expectTypeOf<WorkflowStore>().toHaveProperty('selectNodeCase')
    expectTypeOf<WorkflowStore>().toHaveProperty('waitNode')
    expectTypeOf<WorkflowStore>().toHaveProperty('ensureChildRun')
    expectTypeOf<WorkflowStore>().toHaveProperty('ensureChildWorkflowRun')
    expectTypeOf<WorkflowStore>().toHaveProperty('loadNodeChildren')
    expectTypeOf<WorkflowStore>().toMatchTypeOf<
      WorkflowStoreWithRequiredSemanticMethods
    >()
    expectTypeOf<
      Extract<OptionalKeys<WorkflowStore>, keyof SemanticWorkflowStoreMethods>
    >().toEqualTypeOf<never>()
    const requiredStoreMethods: SemanticWorkflowStoreMethods = {} as WorkflowStore
    expect(requiredStoreMethods).toBeDefined()
  })

  it('routes workflow and task implementations by contract name', () => {
    const task = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })

    const child = defineWorkflow({
      name: 'child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()

    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .workflow('child', child)
      .build()

    const taskImpl = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const childImpl = implementWorkflow(child).finish((_ctx, _outputs, input) => ({
      text: input.text,
    }))
    const parentImpl = implementWorkflow(parent)
      .embedding(task, { input: (_ctx, _outputs, input) => input })
      .child(child, { input: (_ctx, { embedding }) => ({ text: embedding.id }) })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))

    const registry = createWorkflowRuntimeRegistry({
      workflows: [parentImpl, childImpl],
      tasks: [taskImpl],
    })

    expect(registry.getWorkflow('parent')).toBe(parentImpl)
    expect(registry.getTask('embedding.generate')).toBe(taskImpl)
    expect(registry.validateRouteability(parentImpl)).toStrictEqual([])
  })

  it('rejects duplicate workflow and task implementation names', () => {
    const task = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()

    expect(() =>
      createWorkflowRuntimeRegistry({
        tasks: [
          implementTask(task, {
            handler: async (_ctx, input) => ({ id: input.text }),
          }),
          implementTask(task, {
            handler: async (_ctx, input) => ({ id: input.text }),
          }),
        ],
      }),
    ).toThrow('Duplicate task implementation [embedding.generate]')

    expect(() =>
      createWorkflowRuntimeRegistry({
        workflows: [
          implementWorkflow(workflow).finish((_ctx, _outputs, input) => input),
          implementWorkflow(workflow).finish((_ctx, _outputs, input) => input),
        ],
      }),
    ).toThrow('Duplicate workflow implementation [parent]')
  })

  it('requires route implementations to match the node declaration identity', () => {
    const expectedTask = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const sameNameTask = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', expectedTask)
      .build()
    const parentImpl = implementWorkflow(parent)
      .embedding(expectedTask, { input: (_ctx, _outputs, input) => input })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))
    const wrongTaskImpl = implementTask(sameNameTask, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })

    const registry = createWorkflowRuntimeRegistry({ tasks: [wrongTaskImpl] })

    expect(registry.validateRouteability(parentImpl)).toStrictEqual([
      'task:embedding.generate',
    ])
  })

  it('reports missing routes from transitive child workflows', () => {
    const childTask = defineTask({
      name: 'child.task',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const child = defineWorkflow({
      name: 'child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .task('childTask', childTask)
      .build()
    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', child)
      .build()
    const childImpl = implementWorkflow(child)
      .childTask(childTask, { input: (_ctx, _outputs, input) => input })
      .finish((_ctx, { childTask }) => childTask)
    const parentImpl = implementWorkflow(parent)
      .child(child, { input: (_ctx, _outputs, input) => input })
      .finish((_ctx, { child }) => child)

    const registry = createWorkflowRuntimeRegistry({
      workflows: [parentImpl, childImpl],
    })

    expect(registry.validateRouteability(parentImpl)).toStrictEqual([
      'task:child.task',
    ])
  })

  it('reports missing routes from branch, parallel, and map nodes', () => {
    const task = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const child = defineWorkflow({
      name: 'child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parent = defineWorkflow({
      name: 'parent',
      input: t.object({ text: t.string() }),
      output: t.object({ ok: t.boolean() }),
    })
      .branch('choice', {
        cases: (helpers) => ({ embedding: helpers.task(task) }),
      })
      .parallel('fanout', (helpers) => ({ child: helpers.workflow(child) }))
      .mapTask('embeddings', task, {
        item: t.object({ text: t.string() }),
        mode: 'wait-all',
      })
      .mapWorkflow('children', child, {
        item: t.object({ text: t.string() }),
        mode: 'wait-all',
      })
      .build()
    const parentImpl = implementWorkflow(parent)
      .choice({
        select: () => 'embedding',
        cases: (helpers) => ({ embedding: helpers.task(task) }),
      })
      .fanout((helpers) => ({ child: helpers.workflow(child) }))
      .embeddings(task, {
        items: (_ctx, _outputs, input) => [input],
        input: (_ctx, _outputs, item) => item,
      })
      .children(child, {
        items: (_ctx, _outputs, input) => [input],
        input: (_ctx, _outputs, item) => item,
      })
      .finish(() => ({ ok: true }))

    const registry = createWorkflowRuntimeRegistry({})

    expect(registry.validateRouteability(parentImpl)).toStrictEqual([
      'task:embedding.generate',
      'workflow:child',
    ])
  })
})
