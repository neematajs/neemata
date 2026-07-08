import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  ActivityImplementation,
  AttemptLifecycle,
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunKind,
  RunnableRun,
  SchemaInput,
  SchemaOutput,
  TaskInput,
  TaskRun,
  WorkflowBuilder,
  WorkflowInput,
  WorkflowRun,
  WorkflowStatus,
} from '../src/index.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  type AttemptCommand,
  type AttemptExecutor,
  ATTEMPT_TRANSITIONS,
  type ContinueRunCommand,
  type ContinueWorkflowRunResult,
  type CreateAttemptInput,
  type CreateRunInput,
  type EnsureChildAttemptParams,
  type EnsureChildAttemptResult,
  type EnsureChildRunParams,
  type EnsureChildRunResult,
  type EnsureNodeChildInput,
  type EnsureNodeChildrenParams,
  type EnsureNodeChildrenResult,
  type InMemoryWorkflowRuntime,
  type ListRunsFilter,
  type ListRunSummariesResult,
  type ListRunsResult,
  type LoadNodeChildrenParams,
  type NodeChildKind,
  type NodeChildRef,
  type NodeChildrenSnapshot,
  type NodeSnapshot,
  NODE_TRANSITIONS,
  type ParsedChildKey,
  type RequestRunCancellationParams,
  type RunDetail,
  type RunFamilyEntry,
  type RunCoordinationExecutor,
  type RunSnapshot,
  type RunSummary,
  type RuntimeNodeStatus,
  type RuntimeRunStatus,
  RUN_TRANSITIONS,
  SELF_CHILD_KEY,
  type SelectNodeCaseParams,
  type SelectNodeCaseParams as RuntimeSelectNodeCaseParams,
  type StartWorkflowRunInput,
  type StoredAttempt,
  type StoredNode,
  type StoredNodeChild,
  type StoredRun,
  type TransitionMap,
  type WaitNodeParams,
  type WorkerCommandResult,
  type WorkerLoopOptions,
  type WorkerLoopResult,
  type WorkflowRuntimeClient,
  type WorkflowRuntimeStartOptions,
  type WorkflowRuntimeAdapter,
  type WorkflowStore,
  type WorkflowAttemptTimeoutError,
  canTransition,
  caseChildKey,
  itemChildKey,
  memberChildKey,
  parseChildKey,
  transitionSources,
} from '../src/runtime/index.ts'
import {
  createWorkflowRuntimeRegistry,
  type RegisteredTaskImplementation,
  type RegisteredWorkflowImplementation,
} from '../src/runtime/registry.ts'

type SemanticWorkflowStoreMethods = {
  listRuns(params?: ListRunsFilter): Promise<ListRunsResult>
  selectNodeCase(params: SelectNodeCaseParams): Promise<StoredNode | undefined>
  ensureNodeChildren(
    params: EnsureNodeChildrenParams,
  ): Promise<EnsureNodeChildrenResult>
  ensureChildRun(params: EnsureChildRunParams): Promise<EnsureChildRunResult>
  ensureChildAttempt(
    params: EnsureChildAttemptParams,
  ): Promise<EnsureChildAttemptResult>
  createAttempt(input: CreateAttemptInput): Promise<StoredAttempt>
  completeNodeChild(
    params: NodeChildRef & { output: unknown },
  ): Promise<StoredNodeChild | undefined>
  failNodeChild(
    params: NodeChildRef & { error: unknown },
  ): Promise<StoredNodeChild | undefined>
  waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>
  markRunRunning(params: { runId: string }): Promise<StoredRun | undefined>
  markRunWaiting(params: { runId: string }): Promise<StoredRun | undefined>
  cancelNode(params: {
    runId: string
    nodeName: string
  }): Promise<StoredNode | undefined>
  cancelNonTerminalRunNodes(params: {
    runId: string
  }): Promise<readonly StoredNode[]>
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
  it('exports adapter-free runtime contracts from the runtime subpath', () => {
    expectTypeOf<ContinueRunCommand>().toExtend<{
      kind: 'continueRun'
      runId: string
      workflowName: string
    }>()

    expectTypeOf<AttemptCommand>().toExtend<{
      attemptId: string
      leaseToken: string
      workflowName: string
      runId: string
      nodeName: string
    }>()

    expectTypeOf<RunCoordinationExecutor>().toHaveProperty('enqueue')
    expectTypeOf<AttemptExecutor>().toHaveProperty('dispatchActivity')
    expectTypeOf<AttemptExecutor>().toHaveProperty('deleteUnclaimed')
    expectTypeOf<WorkflowStore>().toHaveProperty('createRun')
    expectTypeOf<WorkflowStore>().toHaveProperty('requestRunCancellation')
    expectTypeOf<WorkflowRuntimeAdapter>().toExtend<{
      store: WorkflowStore
      runCoordinationExecutor: RunCoordinationExecutor
      attemptExecutor: AttemptExecutor
    }>()
    expectTypeOf<InMemoryWorkflowRuntime>().toExtend<WorkflowRuntimeAdapter>()
    expectTypeOf<CreateRunInput>().toExtend<{
      kind?: RunKind
      name?: string
      workflowName: string
      taskName?: string
    }>()
    expectTypeOf<ListRunsFilter>().toExtend<{
      kind?: RunKind
      name?: string
      status?: RuntimeRunStatus | readonly RuntimeRunStatus[]
      createdBefore?: Date
      parentRunId?: string | null
      rootRunId?: string
      tags?: Readonly<Record<string, string>>
      input?: unknown
      limit?: number
      cursor?: string
    }>()
    expectTypeOf<ListRunsResult>().toExtend<{
      runs: readonly StoredRun[]
      nextCursor?: string
    }>()
    expectTypeOf<ListRunSummariesResult>().toExtend<{
      runs: readonly RunSummary[]
      nextCursor?: string
    }>()
    expectTypeOf<RunDetail>().toExtend<{
      run: RunSummary
      childRuns: readonly RunSummary[]
    }>()
    expectTypeOf<NodeSnapshot>().toExtend<{
      node: StoredNode
      children: readonly StoredNodeChild[]
      attempts: readonly StoredAttempt[]
    }>()
    expectTypeOf<RunFamilyEntry>().toExtend<{
      run: RunSummary
      origin?: { readonly nodeName: string; readonly childKey: string }
    }>()
    expectTypeOf<StoredRun>().toHaveProperty('status')
    expectTypeOf<StoredRun>().toExtend<{
      kind: RunKind
      name: string
      workflowName: string
      taskName?: string
    }>()
    expectTypeOf<StoredNode>().toHaveProperty('status')
    expectTypeOf<StoredAttempt>().toHaveProperty('status')
    expectTypeOf<ContinueWorkflowRunResult>().toExtend<{
      status: 'processed' | 'busy' | 'ignored'
    }>()
    expectTypeOf<WorkerCommandResult>().toExtend<{
      status: 'processed' | 'released'
    }>()
    expectTypeOf<WorkerLoopOptions>().toExtend<{
      workerId: string
      concurrency?: number
      leaseMs?: number
      maxIdleClaims?: number
      idleDelayMs?: number
      signal?: AbortSignal
    }>()
    expectTypeOf<WorkerLoopResult>().toExtend<{ processed: number }>()
    expectTypeOf<WorkflowStatus>().toEqualTypeOf<
      | 'queued'
      | 'running'
      | 'waiting'
      | 'cancelling'
      | 'cancelled'
      | 'failed'
      | 'completed'
    >()
    expectTypeOf<RuntimeRunStatus>().toEqualTypeOf<WorkflowStatus>()
    expectTypeOf<
      SchemaInput<ReturnType<typeof t.date>>
    >().toEqualTypeOf<string>()
    expectTypeOf<
      SchemaOutput<ReturnType<typeof t.date>>
    >().toEqualTypeOf<Date>()
    expectTypeOf<WorkflowRuntimeClient['start']>().toExtend<{
      <Workflow extends AnyWorkflowDefinition>(
        workflow: Workflow,
        input: WorkflowInput<Workflow>,
        options?: WorkflowRuntimeStartOptions,
      ): Promise<WorkflowRun<Workflow>>
      <Task extends AnyTaskDefinition>(
        task: Task,
        input: TaskInput<Task>,
        options?: WorkflowRuntimeStartOptions,
      ): Promise<TaskRun<Task>>
    }>()
    expectTypeOf<WorkflowRuntimeClient>().toHaveProperty('cancel')
    expectTypeOf<WorkflowRuntimeClient>().toHaveProperty('listSummaries')
    expectTypeOf<WorkflowRuntimeClient>().toHaveProperty('getDetail')
    expectTypeOf<WorkflowRuntimeClient>().toHaveProperty('getNode')
    expectTypeOf<WorkflowRuntimeClient>().toHaveProperty('getFamily')
    expectTypeOf<WorkflowRuntimeClient['cancel']>().toExtend<
      (runId: string) => Promise<StoredRun | undefined>
    >()
    expectTypeOf<RequestRunCancellationParams>().toExtend<{
      runId: string
    }>()
    expectTypeOf<typeof WorkflowAttemptTimeoutError>().toBeConstructibleWith({
      runId: 'run-1',
      nodeName: 'node',
      attemptId: 'attempt-1',
      timeoutMs: 1,
    })
    expectTypeOf<ActivityImplementation>().toHaveProperty('handler')
    expectTypeOf<AttemptLifecycle>().toExtend<{
      readonly signal: AbortSignal
    }>()
    expectTypeOf<WorkflowBuilder>().toHaveProperty('build')
    expectTypeOf<RegisteredWorkflowImplementation>().toHaveProperty('workflow')
    expectTypeOf<RegisteredTaskImplementation>().toHaveProperty('task')
    expectTypeOf<StartWorkflowRunInput<any>>().toExtend<{
      workflow: { name: string }
      input: unknown
      tags?: Readonly<Record<string, string>>
      idempotencyKey?: readonly unknown[]
    }>()
    expectTypeOf<TaskRun>().toExtend<{
      id: string
      kind: 'task'
      name: string
      status: WorkflowStatus
    }>()
    expectTypeOf<RunnableRun>().toExtend<
      { kind: 'task' } | { kind: 'workflow' }
    >()
  })

  it('keeps two-arg handlers assignable while allowing lifecycle signals', () => {
    const task = defineTask({
      name: 'handler-lifecycle-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const lifecycleTask = implementTask(task, {
      handler: async (_ctx, input, lifecycle) => {
        expectTypeOf(lifecycle).toEqualTypeOf<AttemptLifecycle | undefined>()
        return {
          id: lifecycle?.signal.aborted ? 'aborted' : input.text,
        }
      },
    })
    const twoArgTask = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })

    expect(lifecycleTask.handler).toBeTypeOf('function')
    expect(twoArgTask.handler).toBeTypeOf('function')
  })

  it('exports semantic orchestration store contracts', () => {
    expectTypeOf<SelectNodeCaseParams>().toExtend<{
      runId: string
      nodeName: string
      caseKey: string
    }>()
    expectTypeOf<RuntimeSelectNodeCaseParams>().toEqualTypeOf<SelectNodeCaseParams>()
    expectTypeOf<NodeChildKind>().toEqualTypeOf<
      'activity' | 'task' | 'workflow'
    >()
    expectTypeOf<StoredNodeChild>().toExtend<{
      runId: string
      nodeName: string
      childKey: string
      kind: NodeChildKind
      status: RuntimeNodeStatus
      ordinal: number
      itemKey?: string
      childRunId?: string
      currentAttemptId?: string
      attemptCount: number
      version: number
    }>()
    expectTypeOf<StoredAttempt>().toExtend<{
      id: string
      runId: string
      nodeName: string
      childKey: string
      attemptNumber: number
    }>()
    expectTypeOf<NodeChildRef>().toEqualTypeOf<{
      readonly runId: string
      readonly nodeName: string
      readonly childKey: string
    }>()
    expectTypeOf<EnsureNodeChildInput>().toExtend<{
      childKey: string
      kind: NodeChildKind
      ordinal?: number
      itemKey?: string
      item?: unknown
    }>()
    expectTypeOf<EnsureNodeChildrenParams>().toExtend<{
      runId: string
      nodeName: string
      children: readonly EnsureNodeChildInput[]
    }>()
    expectTypeOf<EnsureNodeChildrenResult>().toExtend<{
      children: readonly StoredNodeChild[]
      created: boolean
    }>()
    expectTypeOf<EnsureChildRunParams>().toExtend<{
      runId: string
      nodeName: string
      childKey: string
      childKind: RunKind
      childName: string
      input: unknown
      rootRunId: string
      tags?: Readonly<Record<string, string>>
      idempotencyKey?: readonly unknown[]
    }>()
    expectTypeOf<EnsureChildRunResult>().toExtend<{
      child: StoredNodeChild
      childRun: StoredRun
      created: boolean
    }>()
    expectTypeOf<EnsureChildAttemptParams>().toExtend<{
      runId: string
      nodeName: string
      childKey: string
      input: unknown
      idempotencyKey?: readonly unknown[]
    }>()
    expectTypeOf<EnsureChildAttemptResult>().toExtend<{
      attempt: StoredAttempt
      created: boolean
    }>()
    expectTypeOf<CreateAttemptInput>().toExtend<{
      runId: string
      nodeName: string
      childKey: string
      input: unknown
    }>()
    expectTypeOf<NodeChildrenSnapshot>().toExtend<{
      children: readonly StoredNodeChild[]
      attempts: readonly StoredAttempt[]
    }>()
    expectTypeOf<RunSnapshot>().toExtend<{
      run: StoredRun
      nodes: readonly StoredNode[]
      children: readonly StoredNodeChild[]
      attempts: readonly StoredAttempt[]
    }>()
    expectTypeOf<WaitNodeParams>().toExtend<{
      runId: string
      nodeName: string
    }>()
    expectTypeOf<WorkflowStore>().toHaveProperty('listRuns')
    expectTypeOf<WorkflowStore>().toHaveProperty('selectNodeCase')
    expectTypeOf<WorkflowStore>().toHaveProperty('waitNode')
    expectTypeOf<WorkflowStore>().toHaveProperty('ensureNodeChildren')
    expectTypeOf<WorkflowStore>().toHaveProperty('ensureChildRun')
    expectTypeOf<WorkflowStore>().toHaveProperty('ensureChildAttempt')
    expectTypeOf<WorkflowStore>().toHaveProperty('completeNodeChild')
    expectTypeOf<WorkflowStore>().toHaveProperty('failNodeChild')
    expectTypeOf<WorkflowStore>().toHaveProperty('markRunRunning')
    expectTypeOf<WorkflowStore>().toHaveProperty('markRunWaiting')
    expectTypeOf<WorkflowStore>().toHaveProperty('loadNodeChildren')
    expectTypeOf<WorkflowStore>().toExtend<WorkflowStoreWithRequiredSemanticMethods>()
    expectTypeOf<
      Extract<OptionalKeys<WorkflowStore>, keyof SemanticWorkflowStoreMethods>
    >().toEqualTypeOf<never>()
    const requiredStoreMethods: SemanticWorkflowStoreMethods =
      {} as WorkflowStore
    expect(requiredStoreMethods).toBeDefined()
  })

  it('exports child-key helpers and transition maps', () => {
    expect(SELF_CHILD_KEY).toBe('$self')
    expect(caseChildKey('normal')).toBe('case:normal')
    expect(memberChildKey('a')).toBe('member:a')
    expect(itemChildKey(2)).toBe('item:2')
    expect(parseChildKey(SELF_CHILD_KEY)).toStrictEqual({ kind: 'self' })
    expect(parseChildKey(caseChildKey('normal'))).toStrictEqual({
      kind: 'case',
      caseKey: 'normal',
    })
    expect(parseChildKey(memberChildKey('a'))).toStrictEqual({
      kind: 'member',
      memberKey: 'a',
    })
    expect(parseChildKey(itemChildKey(2))).toStrictEqual({
      kind: 'item',
      itemIndex: 2,
    })
    expect(parseChildKey('item:-1')).toBeUndefined()
    expect(parseChildKey('bogus')).toBeUndefined()
    expectTypeOf(parseChildKey).returns.toEqualTypeOf<
      ParsedChildKey | undefined
    >()

    expectTypeOf(RUN_TRANSITIONS).toEqualTypeOf<
      TransitionMap<RuntimeRunStatus>
    >()
    expectTypeOf(NODE_TRANSITIONS).toEqualTypeOf<
      TransitionMap<RuntimeNodeStatus>
    >()
    expect(canTransition(RUN_TRANSITIONS, 'queued', 'running')).toBe(true)
    // Runs park on children only after starting; queued cannot go waiting.
    expect(canTransition(RUN_TRANSITIONS, 'queued', 'waiting')).toBe(false)
    expect(canTransition(RUN_TRANSITIONS, 'completed', 'running')).toBe(false)
    expect(canTransition(NODE_TRANSITIONS, 'pending', 'running')).toBe(true)
    expect(canTransition(ATTEMPT_TRANSITIONS, 'started', 'timedOut')).toBe(true)
    expect(canTransition(ATTEMPT_TRANSITIONS, 'completed', 'failed')).toBe(
      false,
    )
    expect(transitionSources(RUN_TRANSITIONS, 'waiting')).toStrictEqual([
      'running',
    ])
    expect(transitionSources(RUN_TRANSITIONS, 'running')).toStrictEqual([
      'queued',
      'waiting',
    ])
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
    const childImpl = implementWorkflow(child).finish(
      (_ctx, _outputs, input) => ({
        text: input.text,
      }),
    )
    const parentImpl = implementWorkflow(parent)
      .embedding(task, { input: (_ctx, _outputs, input) => input })
      .child(child, {
        input: (_ctx, { embedding }) => ({ text: embedding.id }),
      })
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
