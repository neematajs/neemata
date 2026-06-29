import type {
  Dependencies,
  DependencyContext,
  Handler,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'

import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  IdempotencyConflictPolicy,
  IdempotencyKey,
  MapRunMode,
  MaybePromise,
  TaskInput,
  TaskOutput,
  WorkflowActivityNode,
  WorkflowBranchNode,
  WorkflowChildWorkflowNode,
  WorkflowInput,
  WorkflowMapTaskNode,
  WorkflowMapWorkflowNode,
  WorkflowNode,
  WorkflowNodes,
  WorkflowOutput,
  WorkflowParallelNode,
  WorkflowTaskNode,
} from '../types/index.ts'

export type TaskHandler<Deps extends Dependencies, Input, Output> = HandlerFn<
  Deps,
  [input: Input],
  Output
>

export type TaskIdempotency<Deps extends Dependencies, Input> =
  | ((ctx: DependencyContext<Deps>, input: Input) => IdempotencyKey)
  | {
      key: (ctx: DependencyContext<Deps>, input: Input) => IdempotencyKey
      conflict?: IdempotencyConflictPolicy
    }

export type TaskImplementation<
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Deps extends Dependencies = {},
> = Handler<Deps, [input: TaskInput<Task>], TaskOutput<Task>> & {
  readonly kind: 'taskImplementation'
  readonly task: Task
  readonly idempotency?: TaskIdempotency<Deps, TaskInput<Task>>
}

export function implementTask<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = {},
>(
  task: Task,
  options: {
    dependencies?: Deps
    idempotency?: TaskIdempotency<Deps, TaskInput<Task>>
    handler: TaskHandler<Deps, TaskInput<Task>, TaskOutput<Task>>
  },
): TaskImplementation<Task, Deps> {
  return Object.freeze({
    kind: 'taskImplementation',
    task,
    dependencies: options.dependencies ?? ({} as Deps),
    idempotency: options.idempotency,
    handler: options.handler,
  })
}

export type ActivityHandler<
  Deps extends Dependencies,
  Input,
  Output,
> = HandlerFn<Deps, [input: Input], Output>

export type ActivityImplementation<
  Input = unknown,
  Output = unknown,
  Deps extends Dependencies = Dependencies,
> = Handler<Deps, [input: Input], Output> & {
  readonly kind: 'activityImplementation'
  readonly name: string
}

export type ActivityHandlerInput<
  Input,
  Output,
  Deps extends Dependencies,
> = HandlerInput<Deps, [input: Input], Output>

export type WorkflowNodeIdempotency<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> =
  | ((
      ctx: DependencyContext<WorkflowDeps>,
      outputs: Outputs,
      workflowInput: Input,
    ) => IdempotencyKey)
  | {
      key: (
        ctx: DependencyContext<WorkflowDeps>,
        outputs: Outputs,
        workflowInput: Input,
      ) => IdempotencyKey
      conflict?: IdempotencyConflictPolicy
    }

export type WorkflowMapNodeIdempotency<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  Item,
> =
  | ((
      ctx: DependencyContext<WorkflowDeps>,
      outputs: Outputs,
      item: Item,
      workflowInput: Input,
      index: number,
    ) => IdempotencyKey)
  | {
      key: (
        ctx: DependencyContext<WorkflowDeps>,
        outputs: Outputs,
        item: Item,
        workflowInput: Input,
        index: number,
      ) => IdempotencyKey
      conflict?: IdempotencyConflictPolicy
    }

export type WorkflowStartIdempotency<Deps extends Dependencies, Input> =
  | ((ctx: DependencyContext<Deps>, input: Input) => IdempotencyKey)
  | {
      key: (ctx: DependencyContext<Deps>, input: Input) => IdempotencyKey
      conflict?: IdempotencyConflictPolicy
    }

export type WorkflowTags<Deps extends Dependencies, Input> = (
  ctx: DependencyContext<Deps>,
  input: Input,
) => Record<string, string>

export type WorkflowInputMapper<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  NodeInput,
> = {
  readonly input?: (
    ctx: DependencyContext<WorkflowDeps>,
    outputs: Outputs,
    workflowInput: Input,
  ) => NodeInput
  readonly idempotency?: WorkflowNodeIdempotency<WorkflowDeps, Outputs, Input>
}

export type WorkflowMapInputMapper<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  Item,
  NodeInput,
> = {
  readonly items: (
    ctx: DependencyContext<WorkflowDeps>,
    outputs: Outputs,
    workflowInput: Input,
  ) => readonly Item[]
  readonly input: (
    ctx: DependencyContext<WorkflowDeps>,
    outputs: Outputs,
    item: Item,
    workflowInput: Input,
    index: number,
  ) => NodeInput
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
  readonly idempotency?: WorkflowStartIdempotency<
    WorkflowDeps,
    WorkflowInput<Workflow>
  >
  readonly tags?: WorkflowTags<WorkflowDeps, WorkflowInput<Workflow>>
  readonly nodes: readonly WorkflowNodeImplementation[]
  readonly finish: (
    ctx: DependencyContext<WorkflowDeps>,
    outputs: any,
    workflowInput: WorkflowInput<Workflow>,
  ) => MaybePromise<WorkflowOutput<Workflow>>
}

type StoredCallback = (...args: any[]) => unknown

export type ActivityNodeImplementation = {
  readonly kind: 'activity'
  readonly name: string
  readonly activity: ActivityImplementation
  readonly input?: StoredCallback
  readonly idempotency?: unknown
}

export type RunnableNodeImplementation = {
  readonly kind: 'task' | 'workflow'
  readonly name: string
  readonly target: AnyTaskDefinition | AnyWorkflowDefinition
  readonly input?: StoredCallback
  readonly idempotency?: unknown
}

export type MapNodeImplementation = {
  readonly kind: 'mapTask' | 'mapWorkflow'
  readonly name: string
  readonly target: AnyTaskDefinition | AnyWorkflowDefinition
  readonly mode: MapRunMode
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
  | {
      readonly kind: 'activity'
      readonly name: string
      readonly activity: ActivityImplementation
      readonly input?: StoredCallback
      readonly idempotency?: unknown
    }
  | {
      readonly kind: 'task' | 'workflow'
      readonly name: string
      readonly target: AnyTaskDefinition | AnyWorkflowDefinition
      readonly input?: StoredCallback
      readonly idempotency?: unknown
    }

type ActivityImplementationOptions<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
  NodeInput,
> = WorkflowInputMapper<WorkflowDeps, Outputs, Input, NodeInput>

type ActivityImplementationValue<Input, Output> =
  | ActivityHandlerInput<Input, Output, any>
  | ActivityImplementation<Input, Output, any>

type ActivityCaseDescriptor<Input, Output> = {
  readonly kind: 'activityCase'
  readonly value: ActivityImplementationValue<Input, Output>
  readonly options?: WorkflowInputMapper<any, any, any, Input>
}

type RunnableCaseDescriptor<
  Target extends AnyTaskDefinition | AnyWorkflowDefinition,
  Input,
> = {
  readonly kind: 'runnableCase'
  readonly target: Target
  readonly options?: WorkflowInputMapper<any, any, any, Input>
}

type CaseImplementationValue<Case> =
  Case extends BranchCaseDefinition<'activity', infer Input, infer Output>
    ?
        | ActivityImplementationValue<Input, Output>
        | ActivityCaseDescriptor<Input, Output>
    : Case extends BranchCaseDefinition<'task', any, any, infer Task>
      ? Task extends AnyTaskDefinition
        ? Task | RunnableCaseDescriptor<Task, TaskInput<Task>>
        : never
      : Case extends BranchCaseDefinition<'workflow', any, any, infer Workflow>
        ? Workflow extends AnyWorkflowDefinition
          ? Workflow | RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>
          : never
        : never

type CaseImplementationObject<
  Cases extends Record<string, BranchCaseDefinition>,
> = {
  readonly [CaseName in keyof Cases & string]: CaseImplementationValue<
    Cases[CaseName]
  >
}

type CaseImplementers<
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> = {
  readonly activity: <NodeInput, Output>(
    value: ActivityImplementationValue<NodeInput, Output>,
    options?: WorkflowInputMapper<WorkflowDeps, Outputs, Input, NodeInput>,
  ) => ActivityCaseDescriptor<NodeInput, Output>
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
  Cases extends Record<string, BranchCaseDefinition>,
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> = (
  helpers: CaseImplementers<WorkflowDeps, Outputs, Input>,
) => CaseImplementationObject<Cases>

type CaseImplementationArgument<
  Cases extends Record<string, BranchCaseDefinition>,
  WorkflowDeps extends Dependencies,
  Outputs extends object,
  Input,
> =
  | CaseImplementationObject<Cases>
  | CaseImplementationFactory<Cases, WorkflowDeps, Outputs, Input>

type ItemOfMapNode<Node> = Node extends {
  readonly _types?: { readonly input: readonly (infer Item)[] }
}
  ? Item
  : never

type NodeOutput<Node> = Node extends {
  readonly name: infer Name extends string
  readonly _types?: { readonly output: infer Output }
}
  ? { readonly [Key in Name]: Output }
  : {}

export type WorkflowImplementationChain<
  Workflow extends AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies,
  Nodes extends readonly WorkflowNode[],
  Outputs extends object,
  WorkflowArgs = WorkflowInput<Workflow>,
  Result = WorkflowOutput<Workflow>,
> = Nodes extends readonly [
  infer Node,
  ...infer Rest extends readonly WorkflowNode[],
]
  ? Node extends WorkflowActivityNode<
      infer Name extends string,
      infer Input,
      infer Output
    >
    ? {
        readonly [Key in Name]: (
          value: ActivityImplementationValue<Input, Output>,
          options?: ActivityImplementationOptions<
            WorkflowDeps,
            Outputs,
            WorkflowArgs,
            Input
          >,
        ) => WorkflowImplementationChain<
          Workflow,
          WorkflowDeps,
          Rest,
          Outputs & NodeOutput<Node>,
          WorkflowArgs,
          Result
        >
      }
    : Node extends WorkflowTaskNode<
          infer Name extends string,
          infer Task extends AnyTaskDefinition
        >
      ? {
          readonly [Key in Name]: (
            task: Task,
            options?: WorkflowInputMapper<
              WorkflowDeps,
              Outputs,
              WorkflowArgs,
              TaskInput<Task>
            >,
          ) => WorkflowImplementationChain<
            Workflow,
            WorkflowDeps,
            Rest,
            Outputs & NodeOutput<Node>,
            WorkflowArgs,
            Result
          >
        }
      : Node extends WorkflowChildWorkflowNode<
            infer Name extends string,
            infer Child extends AnyWorkflowDefinition
          >
        ? {
            readonly [Key in Name]: (
              workflow: Child,
              options?: WorkflowInputMapper<
                WorkflowDeps,
                Outputs,
                WorkflowArgs,
                WorkflowInput<Child>
              >,
            ) => WorkflowImplementationChain<
              Workflow,
              WorkflowDeps,
              Rest,
              Outputs & NodeOutput<Node>,
              WorkflowArgs,
              Result
            >
          }
        : Node extends WorkflowBranchNode<
              infer Name extends string,
              infer Cases extends Record<string, BranchCaseDefinition>
            >
          ? {
              readonly [Key in Name]: (options: {
                select: (
                  ctx: DependencyContext<WorkflowDeps>,
                  outputs: Outputs,
                  workflowInput: WorkflowArgs,
                ) => keyof Cases & string
                cases: CaseImplementationFactory<
                  Cases,
                  WorkflowDeps,
                  Outputs,
                  WorkflowArgs
                >
              }) => WorkflowImplementationChain<
                Workflow,
                WorkflowDeps,
                Rest,
                Outputs & NodeOutput<Node>,
                WorkflowArgs,
                Result
              >
            }
          : Node extends WorkflowParallelNode<
                infer Name extends string,
                infer Cases extends Record<string, BranchCaseDefinition>
              >
            ? {
                readonly [Key in Name]: (
                  cases: CaseImplementationArgument<
                    Cases,
                    WorkflowDeps,
                    Outputs,
                    WorkflowArgs
                  >,
                ) => WorkflowImplementationChain<
                  Workflow,
                  WorkflowDeps,
                  Rest,
                  Outputs & NodeOutput<Node>,
                  WorkflowArgs,
                  Result
                >
              }
            : Node extends WorkflowMapTaskNode<
                  infer Name extends string,
                  infer Task extends AnyTaskDefinition
                >
              ? {
                  readonly [Key in Name]: (
                    task: Task,
                    options: WorkflowMapInputMapper<
                      WorkflowDeps,
                      Outputs,
                      WorkflowArgs,
                      ItemOfMapNode<Node>,
                      TaskInput<Task>
                    >,
                  ) => WorkflowImplementationChain<
                    Workflow,
                    WorkflowDeps,
                    Rest,
                    Outputs & NodeOutput<Node>,
                    WorkflowArgs,
                    Result
                  >
                }
              : Node extends WorkflowMapWorkflowNode<
                    infer Name extends string,
                    infer Child extends AnyWorkflowDefinition
                  >
                ? {
                    readonly [Key in Name]: (
                      workflow: Child,
                      options: WorkflowMapInputMapper<
                        WorkflowDeps,
                        Outputs,
                        WorkflowArgs,
                        ItemOfMapNode<Node>,
                        WorkflowInput<Child>
                      >,
                    ) => WorkflowImplementationChain<
                      Workflow,
                      WorkflowDeps,
                      Rest,
                      Outputs & NodeOutput<Node>,
                      WorkflowArgs,
                      Result
                    >
                  }
                : WorkflowImplementationChain<
                    Workflow,
                    WorkflowDeps,
                    Rest,
                    Outputs,
                    WorkflowArgs,
                    Result
                  >
  : {
      readonly finish: (
        finish: (
          ctx: DependencyContext<WorkflowDeps>,
          outputs: Outputs,
          workflowInput: WorkflowArgs,
        ) => MaybePromise<Result>,
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
  WorkflowInput<Workflow>,
  WorkflowOutput<Workflow>
>

export function implementWorkflow<
  Workflow extends AnyWorkflowDefinition,
  WorkflowDeps extends Dependencies = {},
>(
  workflow: Workflow,
  options?: {
    dependencies?: WorkflowDeps
    idempotency?: WorkflowStartIdempotency<
      WorkflowDeps,
      WorkflowInput<Workflow>
    >
    tags?: WorkflowTags<WorkflowDeps, WorkflowInput<Workflow>>
  },
): WorkflowImplementer<Workflow, WorkflowDeps> {
  return createWorkflowChain({
    workflow,
    dependencies: options?.dependencies ?? ({} as WorkflowDeps),
    idempotency: options?.idempotency,
    tags: options?.tags,
    index: 0,
    implementations: [],
  }) as WorkflowImplementer<Workflow, WorkflowDeps>
}

function createWorkflowChain(state: {
  workflow: AnyWorkflowDefinition
  dependencies: Dependencies
  idempotency: unknown
  tags: unknown
  index: number
  implementations: readonly WorkflowNodeImplementation[]
}): unknown {
  const node = state.workflow.nodes[state.index]

  if (!node) {
    return Object.freeze({
      finish: (finish: WorkflowImplementation['finish']) =>
        Object.freeze({
          kind: 'workflowImplementation',
          workflow: state.workflow,
          dependencies: state.dependencies,
          idempotency: state.idempotency,
          tags: state.tags,
          nodes: Object.freeze([...state.implementations]),
          finish,
        }),
    })
  }

  switch (node.kind) {
    case 'activity':
      return Object.freeze({
        [node.name]: (
          value: ActivityImplementationValue<unknown, unknown>,
          options?: WorkflowInputMapper<any, any, any, any>,
        ) =>
          nextChain(state, {
            kind: 'activity',
            name: node.name,
            activity: createActivityImplementation(node.name, value),
            input: options?.input,
            idempotency: options?.idempotency,
          }),
      })

    case 'task':
      return Object.freeze({
        [node.name]: (
          task: AnyTaskDefinition,
          options?: WorkflowInputMapper<any, any, any, any>,
        ) => {
          assertSameRunnable(
            node.task,
            task,
            `Workflow task implementation [${node.name}]`,
          )
          return nextChain(state, {
            kind: 'task',
            name: node.name,
            target: task,
            input: options?.input,
            idempotency: options?.idempotency,
          })
        },
      })

    case 'workflow':
      return Object.freeze({
        [node.name]: (
          workflow: AnyWorkflowDefinition,
          options?: WorkflowInputMapper<any, any, any, any>,
        ) => {
          assertSameRunnable(
            node.workflow,
            workflow,
            `Workflow child implementation [${node.name}]`,
          )
          return nextChain(state, {
            kind: 'workflow',
            name: node.name,
            target: workflow,
            input: options?.input,
            idempotency: options?.idempotency,
          })
        },
      })

    case 'mapTask':
      return Object.freeze({
        [node.name]: (
          task: AnyTaskDefinition,
          options: WorkflowMapInputMapper<any, any, any, any, any>,
        ) => {
          assertSameRunnable(
            node.task,
            task,
            `Workflow map task implementation [${node.name}]`,
          )
          return nextChain(state, {
            kind: 'mapTask',
            name: node.name,
            target: task,
            mode: node.mode,
            concurrency: node.concurrency,
            items: options.items,
            input: options.input,
            idempotency: options.idempotency,
          })
        },
      })

    case 'mapWorkflow':
      return Object.freeze({
        [node.name]: (
          workflow: AnyWorkflowDefinition,
          options: WorkflowMapInputMapper<any, any, any, any, any>,
        ) => {
          assertSameRunnable(
            node.workflow,
            workflow,
            `Workflow map child implementation [${node.name}]`,
          )
          return nextChain(state, {
            kind: 'mapWorkflow',
            name: node.name,
            target: workflow,
            mode: node.mode,
            concurrency: node.concurrency,
            items: options.items,
            input: options.input,
            idempotency: options.idempotency,
          })
        },
      })

    case 'branch':
      return Object.freeze({
        [node.name]: (options: {
          select: (...args: readonly unknown[]) => string
          cases: CaseImplementationFactory<any, any, any, any>
        }) => {
          const cases = options.cases(createCaseImplementers())

          return nextChain(state, {
            kind: 'branch',
            name: node.name,
            select: options.select,
            cases: Object.freeze(normalizeCases(node, cases)),
          })
        },
      })

    case 'parallel':
      return Object.freeze({
        [node.name]: (
          casesOrFactory: CaseImplementationArgument<any, any, any, any>,
        ) => {
          const cases =
            typeof casesOrFactory === 'function'
              ? casesOrFactory(createCaseImplementers())
              : casesOrFactory

          return nextChain(state, {
            kind: 'parallel',
            name: node.name,
            cases: Object.freeze(normalizeCases(node, cases)),
          })
        },
      })
  }
}

function nextChain(
  state: {
    workflow: AnyWorkflowDefinition
    dependencies: Dependencies
    idempotency: unknown
    tags: unknown
    index: number
    implementations: readonly WorkflowNodeImplementation[]
  },
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
    activity: <NodeInput, Output>(
      value: ActivityImplementationValue<NodeInput, Output>,
      options?: WorkflowInputMapper<any, any, any, NodeInput>,
    ) =>
      Object.freeze({
        kind: 'activityCase',
        value,
        options,
      }) as ActivityCaseDescriptor<NodeInput, Output>,
    task: <Task extends AnyTaskDefinition>(
      task: Task,
      options?: WorkflowInputMapper<any, any, any, any>,
    ) =>
      Object.freeze({
        kind: 'runnableCase',
        target: task,
        options,
      }) as RunnableCaseDescriptor<Task, TaskInput<Task>>,
    workflow: <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      options?: WorkflowInputMapper<any, any, any, any>,
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
  const expectedEntries = Object.entries(node.cases)
  const implementations: Record<string, WorkflowCaseImplementation> = {}

  for (const [caseName, branchCase] of expectedEntries) {
    if (!(caseName in cases)) {
      throw new Error(
        `Missing workflow ${node.kind} case implementation [${node.name}.${caseName}]`,
      )
    }

    implementations[caseName] = normalizeCase(
      `${node.name}.${caseName}`,
      branchCase as BranchCaseDefinition,
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
      input: descriptor?.options?.input,
      idempotency: descriptor?.options?.idempotency,
    })
  }

  const descriptor = isRunnableCaseDescriptor(value) ? value : undefined
  const target = descriptor?.target ?? value
  const runnableCase = branchCase as BranchCaseDefinition<
    'task' | 'workflow',
    any,
    any,
    AnyTaskDefinition | AnyWorkflowDefinition
  >
  assertSameRunnable(
    runnableCase.target,
    target,
    `Workflow ${branchCase.kind} case implementation [${name}]`,
  )

  return Object.freeze({
    kind: branchCase.kind,
    name,
    target: target as AnyTaskDefinition | AnyWorkflowDefinition,
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

  const { dependencies = {}, handler } =
    typeof value === 'function' ? { handler: value } : (value as any)

  return Object.freeze({
    kind: 'activityImplementation',
    name,
    dependencies,
    handler,
  })
}

function isActivityImplementation(
  value: unknown,
): value is ActivityImplementation {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'activityImplementation',
  )
}

function isActivityCaseDescriptor(
  value: unknown,
): value is ActivityCaseDescriptor<unknown, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'activityCase',
  )
}

function isRunnableCaseDescriptor(
  value: unknown,
): value is RunnableCaseDescriptor<
  AnyTaskDefinition | AnyWorkflowDefinition,
  unknown
> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'runnableCase',
  )
}

function assertSameRunnable(
  expected: AnyTaskDefinition | AnyWorkflowDefinition,
  actual: unknown,
  label: string,
) {
  if (actual === expected) return

  const actualName =
    actual && typeof actual === 'object' && 'name' in actual
      ? String(actual.name)
      : 'unknown'

  throw new Error(
    `${label} does not match contract: expected [${expected.name}], received [${actualName}]`,
  )
}
