import type {
  Dependencies,
  DependencyContext,
  Handler,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'
import { createHandler } from '@nmtjs/core'

import type {
  ActivityCaseDefinition,
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BoundaryInput,
  BoundaryOutput,
  BranchCaseDefinition,
  BranchCases,
  IdempotencyKey,
  MaybePromise,
  RetryPolicy,
  TaskCaseDefinition,
  TaskDecodedInput,
  TaskInput,
  TaskOutputInput,
  WorkflowActivityNode,
  WorkflowBranchNode,
  WorkflowCaseDefinition,
  WorkflowChildWorkflowNode,
  WorkflowDecodedInput,
  WorkflowInput,
  WorkflowMapTaskNode,
  WorkflowMapWorkflowNode,
  WorkflowNode,
  WorkflowNodes,
  WorkflowOutputInput,
  WorkflowParallelNode,
  WorkflowTaskNode,
} from '../types/index.ts'

export type AttemptLifecycle = {
  readonly signal: AbortSignal
}

type AttemptArgs<Input> = [input: Input, lifecycle?: AttemptLifecycle]

export type TaskHandler<Deps extends Dependencies, Input, Output> = HandlerFn<
  Deps,
  AttemptArgs<Input>,
  Output
>

export type TaskImplementation<
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
> = Handler<
  Deps,
  AttemptArgs<TaskDecodedInput<Task>>,
  TaskOutputInput<Task>
> & {
  readonly kind: 'taskImplementation'
  readonly task: Task
}

export function implementTask<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = {},
>(
  task: Task,
  options: {
    dependencies?: Deps
    handler: TaskHandler<Deps, TaskDecodedInput<Task>, TaskOutputInput<Task>>
  },
): TaskImplementation<Task, Deps> {
  return Object.freeze({
    kind: 'taskImplementation',
    task,
    dependencies: options.dependencies ?? ({} as Deps),
    handler: options.handler,
  })
}

export type ActivityImplementation<
  Input = unknown,
  Output = unknown,
  Deps extends Dependencies = Dependencies,
> = Handler<Deps, AttemptArgs<Input>, Output> & {
  readonly kind: 'activityImplementation'
  readonly name: string
}

export type ActivityHandlerInput<
  Input,
  Output,
  Deps extends Dependencies,
> = HandlerInput<Deps, AttemptArgs<Input>, Output>

/** Both callback shapes a node option accepts: bare, or wrapped in `{ key }`. */
type KeyOrFn<Callback> = Callback | { key: Callback }

type NodeCallback<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  Return,
> = (
  ctx: DependencyContext<WorkflowDeps>,
  outputs: Outputs,
  workflowInput: Input,
) => Return

type MapItemCallback<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  Item,
  Return,
> = (
  ctx: DependencyContext<WorkflowDeps>,
  outputs: Outputs,
  item: Item,
  workflowInput: Input,
  index: number,
) => Return

export type WorkflowNodeIdempotency<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> = KeyOrFn<NodeCallback<WorkflowDeps, Outputs, Input, IdempotencyKey>>

export type WorkflowMapNodeIdempotency<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  Item,
> = KeyOrFn<MapItemCallback<WorkflowDeps, Outputs, Input, Item, IdempotencyKey>>

export type WorkflowInputMapper<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  NodeInput,
> = {
  readonly input?: NodeCallback<WorkflowDeps, Outputs, Input, NodeInput>
  readonly idempotency?: WorkflowNodeIdempotency<WorkflowDeps, Outputs, Input>
}

export type WorkflowMapInputMapper<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  ItemInput,
  Item,
  NodeInput,
> = {
  readonly items: NodeCallback<
    WorkflowDeps,
    Outputs,
    Input,
    readonly ItemInput[]
  >
  readonly input: MapItemCallback<WorkflowDeps, Outputs, Input, Item, NodeInput>
  readonly idempotency?: WorkflowMapNodeIdempotency<
    WorkflowDeps,
    Outputs,
    Input,
    Item
  >
}

export type WorkflowImplementation<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies = Dependencies,
> = {
  readonly kind: 'workflowImplementation'
  readonly workflow: Workflow
  readonly dependencies: WorkflowDeps
  readonly nodes: readonly WorkflowNodeImplementation[]
  readonly finish: (
    ctx: DependencyContext<WorkflowDeps>,
    outputs: any,
    workflowInput: WorkflowDecodedInput<Workflow>,
  ) => MaybePromise<WorkflowOutputInput<Workflow>>
}

type StoredCallback = (...args: any[]) => unknown

export type ActivityNodeImplementation = {
  readonly kind: 'activity'
  readonly name: string
  readonly activity: ActivityImplementation
  readonly retry?: RetryPolicy
  readonly input?: StoredCallback
  readonly idempotency?: unknown
}

export type RunnableNodeImplementation = {
  readonly kind: 'task' | 'workflow'
  readonly name: string
  readonly target: AnyTaskDefinition | AnyWorkflowDefinition
  readonly retry?: RetryPolicy
  readonly input?: StoredCallback
  readonly idempotency?: unknown
}

export type MapNodeImplementation = {
  readonly kind: 'mapTask' | 'mapWorkflow'
  readonly name: string
  readonly target: AnyTaskDefinition | AnyWorkflowDefinition
  readonly concurrency?: number
  readonly items: (...args: any[]) => readonly unknown[]
  readonly input: StoredCallback
  readonly idempotency?: unknown
}

export type BranchNodeImplementation = {
  readonly kind: 'branch'
  readonly name: string
  readonly select: (...args: any[]) => string
  readonly cases: Readonly<Record<string, WorkflowCaseImplementation>>
}

export type ParallelNodeImplementation = {
  readonly kind: 'parallel'
  readonly name: string
  readonly cases: Readonly<Record<string, WorkflowCaseImplementation>>
}

export type WorkflowNodeImplementation =
  | ActivityNodeImplementation
  | RunnableNodeImplementation
  | MapNodeImplementation
  | BranchNodeImplementation
  | ParallelNodeImplementation

export type WorkflowCaseImplementation =
  | ActivityNodeImplementation
  | RunnableNodeImplementation

type ActivityImplementationValue<
  Input,
  Output,
  Deps extends Dependencies = Dependencies,
> =
  | ActivityHandlerInput<Input, Output, Deps>
  | ActivityImplementation<Input, Output, Deps>

type ActivityCaseDescriptor<
  Input,
  Output,
  Deps extends Dependencies = Dependencies,
> = {
  readonly kind: 'activityCase'
  readonly value: ActivityImplementationValue<Input, Output, Deps>
  readonly options?: WorkflowInputMapper<any, any, any, Input>
}

type AnyActivityImplementationValue<Input, Output> =
  ActivityImplementationValue<Input, Output, any>

type AnyActivityCaseDescriptor<Input, Output> = ActivityCaseDescriptor<
  Input,
  Output,
  any
>

type RunnableCaseDescriptor<
  Target extends AnyTaskDefinition | AnyWorkflowDefinition,
  Input,
> = {
  readonly kind: 'runnableCase'
  readonly target: Target
  readonly options?: WorkflowInputMapper<any, any, any, Input>
}

type CaseImplementationValue<Case> =
  Case extends ActivityCaseDefinition<infer Input, infer Output>
    ?
        | AnyActivityImplementationValue<
            BoundaryOutput<Input>,
            BoundaryInput<Output>
          >
        | AnyActivityCaseDescriptor<
            BoundaryOutput<Input>,
            BoundaryInput<Output>
          >
    : Case extends TaskCaseDefinition<
          any,
          any,
          infer Task extends AnyTaskDefinition
        >
      ? Task | RunnableCaseDescriptor<Task, TaskInput<Task>>
      : Case extends WorkflowCaseDefinition<
            any,
            any,
            infer Child extends AnyWorkflowDefinition
          >
        ? Child | RunnableCaseDescriptor<Child, WorkflowInput<Child>>
        : never

type CaseImplementationObject<Cases extends BranchCases> = {
  readonly [CaseName in keyof Cases & string]: CaseImplementationValue<
    Cases[CaseName]
  >
}

type CaseImplementers<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> = {
  readonly activity: <
    NodeInput,
    Output,
    Deps extends Dependencies = Dependencies,
  >(
    value: ActivityImplementationValue<NodeInput, Output, Deps>,
    options?: WorkflowInputMapper<WorkflowDeps, Outputs, Input, NodeInput>,
  ) => ActivityCaseDescriptor<NodeInput, Output, Deps>
  readonly task: <Task extends AnyTaskDefinition>(
    task: Task,
    options?: WorkflowInputMapper<
      WorkflowDeps,
      Outputs,
      Input,
      TaskInput<Task>
    >,
  ) => RunnableCaseDescriptor<Task, TaskInput<Task>>
  readonly workflow: <Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    options?: WorkflowInputMapper<
      WorkflowDeps,
      Outputs,
      Input,
      WorkflowInput<Workflow>
    >,
  ) => RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>
}

type CaseImplementationFactory<
  Cases extends BranchCases,
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> = (
  helpers: CaseImplementers<WorkflowDeps, Outputs, Input>,
) => CaseImplementationObject<Cases>

type CaseImplementationArgument<
  Cases extends BranchCases,
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> =
  | CaseImplementationObject<Cases>
  | CaseImplementationFactory<Cases, WorkflowDeps, Outputs, Input>

type ItemOfMapNode<Node> = Node extends {
  readonly _types?: { readonly input: infer Input }
}
  ? BoundaryOutput<Input> extends readonly (infer Item)[]
    ? Item
    : never
  : never

type InputItemOfMapNode<Node> = Node extends {
  readonly _types?: { readonly input: infer Input }
}
  ? BoundaryInput<Input> extends readonly (infer Item)[]
    ? Item
    : never
  : never

type NodeOutput<Node> = Node extends {
  readonly name: infer Name extends string
  readonly _types?: { readonly output: infer Output }
}
  ? { readonly [Key in Name]: BoundaryOutput<Output> }
  : {}

/** The method a single node contributes to the chain, returning `Next`. */
type NodeImplementer<
  Node,
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  WorkflowArgs,
  Next,
> =
  Node extends WorkflowActivityNode<string, infer Input, infer Output>
    ? <Deps extends Dependencies = Dependencies>(
        value: ActivityImplementationValue<
          BoundaryOutput<Input>,
          BoundaryInput<Output>,
          Deps
        >,
        options?: WorkflowInputMapper<
          WorkflowDeps,
          Outputs,
          WorkflowArgs,
          BoundaryInput<Input>
        >,
      ) => Next
    : Node extends WorkflowTaskNode<string, infer Task>
      ? (
          task: Task,
          options?: WorkflowInputMapper<
            WorkflowDeps,
            Outputs,
            WorkflowArgs,
            TaskInput<Task>
          >,
        ) => Next
      : Node extends WorkflowChildWorkflowNode<string, infer Child>
        ? (
            workflow: Child,
            options?: WorkflowInputMapper<
              WorkflowDeps,
              Outputs,
              WorkflowArgs,
              WorkflowInput<Child>
            >,
          ) => Next
        : Node extends WorkflowBranchNode<string, infer Cases>
          ? (options: {
              select: NodeCallback<
                WorkflowDeps,
                Outputs,
                WorkflowArgs,
                keyof Cases & string
              >
              cases: CaseImplementationFactory<
                Cases,
                WorkflowDeps,
                Outputs,
                WorkflowArgs
              >
            }) => Next
          : Node extends WorkflowParallelNode<string, infer Cases>
            ? (
                cases: CaseImplementationArgument<
                  Cases,
                  WorkflowDeps,
                  Outputs,
                  WorkflowArgs
                >,
              ) => Next
            : Node extends WorkflowMapTaskNode<string, infer Task>
              ? (
                  task: Task,
                  options: WorkflowMapInputMapper<
                    WorkflowDeps,
                    Outputs,
                    WorkflowArgs,
                    InputItemOfMapNode<Node>,
                    ItemOfMapNode<Node>,
                    TaskInput<Task>
                  >,
                ) => Next
              : Node extends WorkflowMapWorkflowNode<string, infer Child>
                ? (
                    workflow: Child,
                    options: WorkflowMapInputMapper<
                      WorkflowDeps,
                      Outputs,
                      WorkflowArgs,
                      InputItemOfMapNode<Node>,
                      ItemOfMapNode<Node>,
                      WorkflowInput<Child>
                    >,
                  ) => Next
                : never

export type WorkflowImplementationChain<
  Workflow extends AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies,
  Nodes extends readonly WorkflowNode[],
  Outputs extends object,
  WorkflowArgs = WorkflowDecodedInput<Workflow>,
  Result = WorkflowOutputInput<Workflow>,
> = Nodes extends readonly [
  infer Node extends WorkflowNode,
  ...infer Rest extends readonly WorkflowNode[],
]
  ? {
      readonly [Key in Node['name']]: NodeImplementer<
        Node,
        WorkflowDeps,
        Outputs,
        WorkflowArgs,
        WorkflowImplementationChain<
          Workflow,
          WorkflowDeps,
          Rest,
          Outputs & NodeOutput<Node>,
          WorkflowArgs,
          Result
        >
      >
    }
  : {
      readonly finish: (
        finish: NodeCallback<
          WorkflowDeps,
          Outputs,
          WorkflowArgs,
          MaybePromise<Result>
        >,
      ) => WorkflowImplementation<Workflow, WorkflowDeps>
    }

export type WorkflowImplementer<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies = {},
> = WorkflowImplementationChain<
  Workflow,
  WorkflowDeps,
  WorkflowNodes<Workflow>,
  {},
  WorkflowDecodedInput<Workflow>,
  WorkflowOutputInput<Workflow>
>

/**
 * Registry-facing erasure: `WorkflowImplementation`'s own `finish` and
 * `TaskImplementation`'s own `handler` are not assignable to their defaults,
 * so every holder of "some implementation" needs these.
 */
export type AnyWorkflowImplementation = Omit<
  WorkflowImplementation,
  'finish'
> & {
  readonly finish: (...args: any[]) => unknown
}

export type AnyTaskImplementation = Omit<TaskImplementation, 'handler'> & {
  readonly handler: (...args: any[]) => unknown
}

export function implementWorkflow<
  Workflow extends AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies = {},
>(
  workflow: Workflow,
  options?: {
    dependencies?: WorkflowDeps
  },
): WorkflowImplementer<Workflow, WorkflowDeps> {
  return createWorkflowChain({
    workflow,
    dependencies: options?.dependencies ?? ({} as WorkflowDeps),
    index: 0,
    implementations: [],
  }) as WorkflowImplementer<Workflow, WorkflowDeps>
}

type ChainState = {
  readonly workflow: AnyWorkflowDefinition
  readonly dependencies: Dependencies
  readonly index: number
  readonly implementations: readonly WorkflowNodeImplementation[]
}

type AnyInputMapper = WorkflowInputMapper<any, any, any, any>
type AnyMapInputMapper = WorkflowMapInputMapper<any, any, any, any, any, any>

function createWorkflowChain(state: ChainState): unknown {
  const node = state.workflow.nodes[state.index]

  if (!node) {
    return Object.freeze({
      finish: (finish: WorkflowImplementation['finish']) =>
        Object.freeze({
          kind: 'workflowImplementation',
          workflow: state.workflow,
          dependencies: state.dependencies,
          nodes: Object.freeze([...state.implementations]),
          finish,
        }),
    })
  }

  // Every node exposes one method named after it, and every method hands its
  // implementation to the chain step for the next node.
  const step = <Args extends readonly any[]>(
    implement: (...args: Args) => WorkflowNodeImplementation,
  ) =>
    Object.freeze({
      [node.name]: (...args: Args) => nextChain(state, implement(...args)),
    })

  switch (node.kind) {
    case 'activity':
      return step(
        (
          value: ActivityImplementationValue<unknown, unknown>,
          options?: AnyInputMapper,
        ) => ({
          kind: 'activity',
          name: node.name,
          activity: createActivityImplementation(node.name, value),
          retry: node.retry,
          input: options?.input,
          idempotency: options?.idempotency,
        }),
      )

    case 'task':
    case 'workflow': {
      const declared = node.kind === 'task' ? node.task : node.workflow
      const label = node.kind === 'task' ? 'task' : 'child'
      const retry = node.kind === 'task' ? node.retry : undefined

      return step(
        (
          target: AnyTaskDefinition | AnyWorkflowDefinition,
          options?: AnyInputMapper,
        ) => {
          assertSameRunnable(
            declared,
            target,
            `Workflow ${label} implementation [${node.name}]`,
          )
          return {
            kind: node.kind,
            name: node.name,
            target,
            retry,
            input: options?.input,
            idempotency: options?.idempotency,
          }
        },
      )
    }

    case 'mapTask':
    case 'mapWorkflow': {
      const declared = node.kind === 'mapTask' ? node.task : node.workflow
      const label = node.kind === 'mapTask' ? 'map task' : 'map child'

      return step(
        (
          target: AnyTaskDefinition | AnyWorkflowDefinition,
          options: AnyMapInputMapper,
        ) => {
          assertSameRunnable(
            declared,
            target,
            `Workflow ${label} implementation [${node.name}]`,
          )
          return {
            kind: node.kind,
            name: node.name,
            target,
            concurrency: node.concurrency,
            items: options.items,
            input: options.input,
            idempotency: options.idempotency,
          }
        },
      )
    }

    case 'branch':
      return step(
        (options: {
          select: (...args: readonly unknown[]) => string
          cases: CaseImplementationFactory<any, any, any, any>
        }) => ({
          kind: 'branch',
          name: node.name,
          select: options.select,
          cases: Object.freeze(
            normalizeCases(node, options.cases(createCaseImplementers())),
          ),
        }),
      )

    case 'parallel':
      return step(
        (casesOrFactory: CaseImplementationArgument<any, any, any, any>) => {
          const cases =
            typeof casesOrFactory === 'function'
              ? casesOrFactory(createCaseImplementers())
              : casesOrFactory

          return {
            kind: 'parallel',
            name: node.name,
            cases: Object.freeze(normalizeCases(node, cases)),
          }
        },
      )
  }
}

function nextChain(
  state: ChainState,
  implementation: WorkflowNodeImplementation,
) {
  return createWorkflowChain({
    ...state,
    index: state.index + 1,
    implementations: [...state.implementations, Object.freeze(implementation)],
  })
}

function createCaseImplementers(): CaseImplementers<any, any, any> {
  const helpers: CaseImplementers<any, any, any> = {
    activity: <NodeInput, Output, Deps extends Dependencies = Dependencies>(
      value: ActivityImplementationValue<NodeInput, Output, Deps>,
      options?: WorkflowInputMapper<any, any, any, NodeInput>,
    ) =>
      Object.freeze({
        kind: 'activityCase',
        value,
        options,
      }) as ActivityCaseDescriptor<NodeInput, Output, Deps>,
    task: <Task extends AnyTaskDefinition>(
      task: Task,
      options?: AnyInputMapper,
    ) =>
      Object.freeze({
        kind: 'runnableCase',
        target: task,
        options,
      }) as RunnableCaseDescriptor<Task, TaskInput<Task>>,
    workflow: <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      options?: AnyInputMapper,
    ) =>
      Object.freeze({
        kind: 'runnableCase',
        target: workflow,
        options,
      }) as RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>,
  }

  return Object.freeze(helpers)
}

function normalizeCases(
  node: WorkflowBranchNode | WorkflowParallelNode,
  cases: Record<string, unknown>,
): Record<string, WorkflowCaseImplementation> {
  const implementations: Record<string, WorkflowCaseImplementation> = {}

  for (const [caseName, branchCase] of Object.entries(node.cases)) {
    if (!Object.hasOwn(cases, caseName)) {
      throw new Error(
        `Missing workflow ${node.kind} case implementation [${node.name}.${caseName}]`,
      )
    }

    implementations[caseName] = normalizeCase(
      `${node.name}.${caseName}`,
      branchCase,
      cases[caseName],
    )
  }

  for (const caseName of Object.keys(cases)) {
    if (!Object.hasOwn(node.cases, caseName)) {
      throw new Error(
        `Unknown workflow ${node.kind} case implementation [${node.name}.${caseName}]`,
      )
    }
  }

  return implementations
}

function normalizeCase(
  name: string,
  branchCase: BranchCaseDefinition,
  value: unknown,
): WorkflowCaseImplementation {
  if (branchCase.kind === 'activity') {
    const descriptor = isActivityCaseDescriptor(value) ? value : undefined
    return Object.freeze({
      kind: 'activity',
      name,
      activity: createActivityImplementation(name, descriptor?.value ?? value),
      retry: branchCase.retry,
      input: descriptor?.options?.input,
      idempotency: descriptor?.options?.idempotency,
    })
  }

  const descriptor = isRunnableCaseDescriptor(value) ? value : undefined
  const target = descriptor?.target ?? value
  assertSameRunnable(
    branchCase.target,
    target,
    `Workflow ${branchCase.kind} case implementation [${name}]`,
  )

  return Object.freeze({
    kind: branchCase.kind,
    name,
    target,
    retry: branchCase.kind === 'task' ? branchCase.retry : undefined,
    input: descriptor?.options?.input,
    idempotency: descriptor?.options?.idempotency,
  })
}

function createActivityImplementation(
  name: string,
  value: unknown,
): ActivityImplementation {
  if (isActivityImplementation(value)) {
    return value
  }

  // Branch and parallel cases arrive as user values, so the handler shape is
  // only guaranteed by the case type.
  const handler = value as ActivityHandlerInput<unknown, unknown, Dependencies>

  return Object.freeze({
    kind: 'activityImplementation',
    name,
    ...createHandler(handler),
  })
}

function isActivityImplementation(
  value: unknown,
): value is ActivityImplementation {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'activityImplementation'
  )
}

function isActivityCaseDescriptor(
  value: unknown,
): value is ActivityCaseDescriptor<unknown, unknown, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'activityCase'
  )
}

function isRunnableCaseDescriptor(
  value: unknown,
): value is RunnableCaseDescriptor<
  AnyTaskDefinition | AnyWorkflowDefinition,
  unknown
> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'runnableCase'
  )
}

function assertSameRunnable<
  T extends AnyTaskDefinition | AnyWorkflowDefinition,
>(expected: T, actual: unknown, label: string): asserts actual is T {
  if (actual === expected) return

  const actualName =
    actual && typeof actual === 'object' && 'name' in actual
      ? String(actual.name)
      : 'unknown'

  throw new Error(
    `${label} does not match contract: expected [${expected.name}], received [${actualName}]`,
  )
}
