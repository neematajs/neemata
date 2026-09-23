import type * as Effect from 'effect/Effect'

import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  IdempotencyKey,
  RetryPolicy,
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

export type AttemptLifecycle = {
  readonly signal: AbortSignal
}

export type TaskHandler<Deps, Input, Output> = (
  input: Input,
  lifecycle: AttemptLifecycle,
) => Effect.Effect<Output, unknown, Deps>

export type TaskImplementation<
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Deps = never,
> = {
  readonly kind: 'taskImplementation'
  readonly task: Task
  readonly handler: TaskHandler<Deps, TaskInput<Task>, TaskOutput<Task>>
}

export function implementTask<Task extends AnyTaskDefinition, Deps = never>(
  task: Task,
  options: { handler: TaskHandler<Deps, TaskInput<Task>, TaskOutput<Task>> },
): TaskImplementation<Task, Deps> {
  return Object.freeze({
    kind: 'taskImplementation',
    task,
    handler: options.handler,
  })
}

export type ActivityHandler<Deps, Input, Output> = TaskHandler<
  Deps,
  Input,
  Output
>

export type ActivityImplementation<
  Input = unknown,
  Output = unknown,
  Deps = any,
> = {
  readonly kind: 'activityImplementation'
  readonly name: string
  readonly handler: ActivityHandler<Deps, Input, Output>
}

export type ActivityHandlerInput<Input, Output, Deps> = ActivityHandler<
  Deps,
  Input,
  Output
>

export type WorkflowNodeIdempotency<Outputs extends object, Input> =
  | ((outputs: Outputs, workflowInput: Input) => IdempotencyKey)
  | {
      key: (outputs: Outputs, workflowInput: Input) => IdempotencyKey
    }

export type WorkflowMapNodeIdempotency<Outputs extends object, Input, Item> =
  | ((
      outputs: Outputs,
      item: Item,
      workflowInput: Input,
      index: number,
    ) => IdempotencyKey)
  | {
      key: (
        outputs: Outputs,
        item: Item,
        workflowInput: Input,
        index: number,
      ) => IdempotencyKey
    }

export type WorkflowInputMapper<Outputs extends object, Input, NodeInput> = {
  readonly input?: (outputs: Outputs, workflowInput: Input) => NodeInput
  readonly idempotency?: WorkflowNodeIdempotency<Outputs, Input>
}

export type WorkflowMapInputMapper<
  Outputs extends object,
  Input,
  Item,
  NodeInput,
> = {
  readonly items: (outputs: Outputs, workflowInput: Input) => readonly Item[]
  readonly input: (
    outputs: Outputs,
    item: Item,
    workflowInput: Input,
    index: number,
  ) => NodeInput
  readonly idempotency?: WorkflowMapNodeIdempotency<Outputs, Input, Item>
}

export type WorkflowImplementation<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowDeps = never,
> = {
  readonly kind: 'workflowImplementation'
  readonly workflow: Workflow
  readonly nodes: readonly WorkflowNodeImplementation[]
  readonly finish: (
    outputs: any,
    workflowInput: WorkflowInput<Workflow>,
  ) => Effect.Effect<WorkflowOutput<Workflow>, unknown, WorkflowDeps>
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
  | {
      readonly kind: 'activity'
      readonly name: string
      readonly activity: ActivityImplementation
      readonly retry?: RetryPolicy
      readonly input?: StoredCallback
      readonly idempotency?: unknown
    }
  | {
      readonly kind: 'task' | 'workflow'
      readonly name: string
      readonly target: AnyTaskDefinition | AnyWorkflowDefinition
      readonly retry?: RetryPolicy
      readonly input?: StoredCallback
      readonly idempotency?: unknown
    }

type ActivityImplementationOptions<
  Outputs extends object,
  Input,
  NodeInput,
> = WorkflowInputMapper<Outputs, Input, NodeInput>

type ActivityImplementationValue<Input, Output, Deps = never> =
  | ActivityHandlerInput<Input, Output, Deps>
  | { readonly handler: ActivityHandlerInput<Input, Output, Deps> }
  | ActivityImplementation<Input, Output, Deps>

type ActivityCaseDescriptor<Input, Output, Deps = never> = {
  readonly kind: 'activityCase'
  readonly value: ActivityImplementationValue<Input, Output, Deps>
  readonly options?: WorkflowInputMapper<any, any, Input>
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
  readonly options?: WorkflowInputMapper<any, any, Input>
}

type CaseImplementationValue<Case> =
  Case extends BranchCaseDefinition<'activity', infer Input, infer Output>
    ?
        | AnyActivityImplementationValue<Input, Output>
        | AnyActivityCaseDescriptor<Input, Output>
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

type CaseImplementers<Outputs extends object, Input> = {
  readonly activity: <NodeInput, Output, Deps = never>(
    value: ActivityImplementationValue<NodeInput, Output, Deps>,
    options?: WorkflowInputMapper<Outputs, Input, NodeInput>,
  ) => ActivityCaseDescriptor<NodeInput, Output, Deps>
  readonly task: <Task extends AnyTaskDefinition>(
    task: Task,
    options?: WorkflowInputMapper<Outputs, Input, TaskInput<Task>>,
  ) => RunnableCaseDescriptor<Task, TaskInput<Task>>
  readonly workflow: <Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    options?: WorkflowInputMapper<Outputs, Input, WorkflowInput<Workflow>>,
  ) => RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>
}

type CaseRequirements<Cases> = {
  [K in keyof Cases]: Cases[K] extends ActivityCaseDescriptor<any, any, infer R>
    ? R
    : Cases[K] extends ActivityImplementationValue<any, any, infer R>
      ? R
      : never
}[keyof Cases]

type CaseImplementationFactory<
  Cases extends Record<string, BranchCaseDefinition>,
  Outputs extends object,
  Input,
  Values extends CaseImplementationObject<Cases> =
    CaseImplementationObject<Cases>,
> = (helpers: CaseImplementers<Outputs, Input>) => Values

type CaseImplementationArgument<
  Cases extends Record<string, BranchCaseDefinition>,
  Outputs extends object,
  Input,
  Values extends CaseImplementationObject<Cases> =
    CaseImplementationObject<Cases>,
> = Values | CaseImplementationFactory<Cases, Outputs, Input, Values>

type ItemOfMapNode<Node> = Node extends {
  readonly _types?: { readonly input: infer Input }
}
  ? Input extends readonly (infer Item)[]
    ? Item
    : never
  : never

type NodeOutput<Node> = Node extends {
  readonly name: infer Name extends string
  readonly _types?: { readonly output: infer Output }
}
  ? { readonly [Key in Name]: Output }
  : {}

export type WorkflowImplementationChain<
  Workflow extends AnyWorkflowDefinition,
  WorkflowDeps,
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
        readonly [Key in Name]: <Deps = never>(
          value: ActivityImplementationValue<Input, Output, Deps>,
          options?: ActivityImplementationOptions<Outputs, WorkflowArgs, Input>,
        ) => WorkflowImplementationChain<
          Workflow,
          WorkflowDeps | Deps,
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
              readonly [Key in Name]: <
                const Values extends CaseImplementationObject<Cases>,
              >(options: {
                select: (
                  outputs: Outputs,
                  workflowInput: WorkflowArgs,
                ) => keyof Cases & string
                cases: CaseImplementationFactory<
                  Cases,
                  Outputs,
                  WorkflowArgs,
                  Values
                >
              }) => WorkflowImplementationChain<
                Workflow,
                WorkflowDeps | CaseRequirements<Values>,
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
                readonly [Key in Name]: <
                  const Values extends CaseImplementationObject<Cases>,
                >(
                  cases: CaseImplementationArgument<
                    Cases,
                    Outputs,
                    WorkflowArgs,
                    Values
                  >,
                ) => WorkflowImplementationChain<
                  Workflow,
                  WorkflowDeps | CaseRequirements<Values>,
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
      readonly finish: <Deps = never>(
        finish: (
          outputs: Outputs,
          workflowInput: WorkflowArgs,
        ) => Effect.Effect<Result, unknown, Deps>,
      ) => WorkflowImplementation<Workflow, WorkflowDeps | Deps>
    }

export type WorkflowImplementer<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowDeps = never,
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
  WorkflowDeps = never,
>(workflow: Workflow): WorkflowImplementer<Workflow, WorkflowDeps> {
  return createWorkflowChain({
    workflow,
    index: 0,
    implementations: [],
  }) as WorkflowImplementer<Workflow, WorkflowDeps>
}

function createWorkflowChain(state: {
  workflow: AnyWorkflowDefinition
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
          options?: WorkflowInputMapper<any, any, any>,
        ) =>
          nextChain(state, {
            kind: 'activity',
            name: node.name,
            activity: createActivityImplementation(node.name, value),
            retry: node.retry,
            input: options?.input,
            idempotency: options?.idempotency,
          }),
      })

    case 'task':
      return Object.freeze({
        [node.name]: (
          task: AnyTaskDefinition,
          options?: WorkflowInputMapper<any, any, any>,
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
            retry: node.retry,
            input: options?.input,
            idempotency: options?.idempotency,
          })
        },
      })

    case 'workflow':
      return Object.freeze({
        [node.name]: (
          workflow: AnyWorkflowDefinition,
          options?: WorkflowInputMapper<any, any, any>,
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
          options: WorkflowMapInputMapper<any, any, any, any>,
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
          options: WorkflowMapInputMapper<any, any, any, any>,
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
          cases: CaseImplementationFactory<any, any, any>
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
          casesOrFactory: CaseImplementationArgument<any, any, any>,
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

function createCaseImplementers(): CaseImplementers<any, any> {
  const helpers: CaseImplementers<any, any> = {
    activity: <NodeInput, Output, Deps = never>(
      value: ActivityImplementationValue<NodeInput, Output, Deps>,
      options?: WorkflowInputMapper<any, any, NodeInput>,
    ) =>
      Object.freeze({
        kind: 'activityCase',
        value,
        options,
      }) as ActivityCaseDescriptor<NodeInput, Output, Deps>,
    task: <Task extends AnyTaskDefinition>(
      task: Task,
      options?: WorkflowInputMapper<any, any, any>,
    ) =>
      Object.freeze({
        kind: 'runnableCase',
        target: task,
        options,
      }) as RunnableCaseDescriptor<Task, TaskInput<Task>>,
    workflow: <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      options?: WorkflowInputMapper<any, any, any>,
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

  for (const caseName in node.cases) {
    if (Object.hasOwn(node.cases, caseName) === false) continue
    if (caseName in cases === false) {
      throw new Error(
        `Missing workflow ${node.kind} case implementation [${node.name}.${caseName}]`,
      )
    }

    implementations[caseName] = normalizeCase(
      `${node.name}.${caseName}`,
      node.cases[caseName]!,
      cases[caseName],
    )
  }

  for (const caseName of Object.keys(cases)) {
    if (Object.hasOwn(node.cases, caseName) === false) {
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
      retry: 'retry' in branchCase ? branchCase.retry : undefined,
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
    target,
    retry: 'retry' in branchCase ? branchCase.retry : undefined,
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

  const handler =
    typeof value === 'function'
      ? value
      : value !== null && typeof value === 'object' && 'handler' in value
        ? value.handler
        : undefined
  if (typeof handler !== 'function')
    throw new Error(`Missing activity handler [${name}]`)

  return Object.freeze({
    kind: 'activityImplementation',
    name,
    handler: handler as ActivityImplementation['handler'],
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
