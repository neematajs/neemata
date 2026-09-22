import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  IdempotencyKey,
  MaybePromise,
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

type ImplementationEnv<T> =
  T extends TaskImplementation<AnyTaskDefinition, infer E>
    ? E
    : T extends WorkflowImplementation<AnyWorkflowDefinition, infer E>
      ? E
      : never

/**
 * What a worker must pass to serve these implementations: every handler's env
 * at once. A handler that ignores its env contributes nothing.
 */
export type Env<T> = (
  T extends unknown ? (env: ImplementationEnv<T>) => void : never
) extends (env: infer All) => void
  ? All
  : never

export type AttemptLifecycle = {
  readonly signal: AbortSignal
}

/**
 * Dependencies are one value the worker passes to every handler. The engine
 * neither builds nor disposes it; its owner starts the worker with it.
 */
export type TaskHandler<Env, Input, Output> = (
  input: Input,
  lifecycle: AttemptLifecycle,
  env: Env,
) => MaybePromise<Output>

export type FinishHandler<Env, Outputs, Input, Output> = (
  outputs: Outputs,
  workflowInput: Input,
  lifecycle: AttemptLifecycle,
  env: Env,
) => MaybePromise<Output>

// The `any` default is the erased form registries hold: every implementation is
// assignable to it, and it carries no env requirement to check.
export type TaskImplementation<
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Env = any,
> = {
  readonly kind: 'taskImplementation'
  readonly task: Task
  /** The execution pool whose workers run this task. */
  readonly pool: string
  readonly handler: TaskHandler<Env, TaskInput<Task>, TaskOutput<Task>>
}

export function implementTask<Task extends AnyTaskDefinition, Env = unknown>(
  task: Task,
  options: {
    /** The execution pool whose workers run this task. */
    pool: string
    handler: TaskHandler<Env, TaskInput<Task>, TaskOutput<Task>>
  },
): TaskImplementation<Task, Env> {
  return Object.freeze({
    kind: 'taskImplementation',
    task,
    pool: options.pool,
    handler: options.handler,
  })
}

export type ActivityHandler<Env, Input, Output> = TaskHandler<
  Env,
  Input,
  Output
>

export type ActivityImplementation<
  Input = unknown,
  Output = unknown,
  Env = any,
> = {
  readonly kind: 'activityImplementation'
  readonly name: string
  readonly handler: ActivityHandler<Env, Input, Output>
}

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

/**
 * A step bound without a mapper receives the workflow input as is, so the
 * mapper may only be left out when that input is what the step accepts.
 */
export type WorkflowInputMapperArguments<
  Outputs extends object,
  Input,
  NodeInput,
> = [Input] extends [NodeInput]
  ? [options?: WorkflowInputMapper<Outputs, Input, NodeInput>]
  : [
      options: WorkflowInputMapper<Outputs, Input, NodeInput> & {
        readonly input: (outputs: Outputs, workflowInput: Input) => NodeInput
      },
    ]

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
  Env = any,
> = {
  readonly kind: 'workflowImplementation'
  readonly workflow: Workflow
  /** The execution pool whose workers run this workflow's activities. */
  readonly pool: string
  readonly nodes: readonly WorkflowNodeImplementation[]
  readonly finish: FinishHandler<
    Env,
    any,
    WorkflowInput<Workflow>,
    WorkflowOutput<Workflow>
  >
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

// Activities take no placement of their own: they are private steps of their
// workflow and run on its pool. A step that needs its own pool is a task.
export type ActivityImplementationOptions<
  Outputs extends object,
  Input,
  NodeInput,
> = WorkflowInputMapper<Outputs, Input, NodeInput>

type ActivityImplementationValue<Input, Output, Env = unknown> =
  | ActivityHandler<Env, Input, Output>
  | { readonly handler: ActivityHandler<Env, Input, Output> }
  | ActivityImplementation<Input, Output, Env>

type ActivityCaseDescriptor<Input, Output, Env = unknown> = {
  readonly kind: 'activityCase'
  // Type-only: reading Env back out of the value union below infers `any`.
  readonly _env?: (env: Env) => void
  readonly value: ActivityImplementationValue<Input, Output, Env>
  readonly options?: ActivityImplementationOptions<any, any, Input>
}

type AnyActivityImplementationValue<Input, Output> =
  ActivityImplementationValue<Input, Output, any>

type AnyActivityCaseDescriptor<Input, Output> = ActivityCaseDescriptor<
  Input,
  Output,
  any
>

export type RunnableCaseDescriptor<
  Target extends AnyTaskDefinition | AnyWorkflowDefinition,
  Input,
> = {
  readonly kind: 'runnableCase'
  readonly target: Target
  readonly options?: WorkflowInputMapper<any, any, Input>
}

// A case given as a bare value has no mapper, so it is accepted only where the
// workflow input is what the case takes; otherwise a helper must supply one.
type BareCaseValue<WorkflowArgs, Input, Value> = [WorkflowArgs] extends [Input]
  ? Value
  : never

type CaseImplementationValue<Case, WorkflowArgs> =
  Case extends BranchCaseDefinition<'activity', infer Input, infer Output>
    ?
        | BareCaseValue<
            WorkflowArgs,
            Input,
            AnyActivityImplementationValue<Input, Output>
          >
        | AnyActivityCaseDescriptor<Input, Output>
    : Case extends BranchCaseDefinition<'task', any, any, infer Task>
      ? Task extends AnyTaskDefinition
        ?
            | BareCaseValue<WorkflowArgs, TaskInput<Task>, Task>
            | RunnableCaseDescriptor<Task, TaskInput<Task>>
        : never
      : Case extends BranchCaseDefinition<'workflow', any, any, infer Workflow>
        ? Workflow extends AnyWorkflowDefinition
          ?
              | BareCaseValue<WorkflowArgs, WorkflowInput<Workflow>, Workflow>
              | RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>
          : never
        : never

type CaseImplementationObject<
  Cases extends Record<string, BranchCaseDefinition>,
  WorkflowArgs,
> = {
  readonly [CaseName in keyof Cases & string]: CaseImplementationValue<
    Cases[CaseName],
    WorkflowArgs
  >
}

type CaseImplementers<Outputs extends object, Input> = {
  readonly activity: <NodeInput, Output, Env = unknown>(
    value: ActivityImplementationValue<NodeInput, Output, Env>,
    ...options: WorkflowInputMapperArguments<Outputs, Input, NodeInput>
  ) => ActivityCaseDescriptor<NodeInput, Output, Env>
  readonly task: <Task extends AnyTaskDefinition>(
    task: Task,
    ...options: WorkflowInputMapperArguments<Outputs, Input, TaskInput<Task>>
  ) => RunnableCaseDescriptor<Task, TaskInput<Task>>
  readonly workflow: <Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    ...options: WorkflowInputMapperArguments<
      Outputs,
      Input,
      WorkflowInput<Workflow>
    >
  ) => RunnableCaseDescriptor<Workflow, WorkflowInput<Workflow>>
}

type HandlerEnv<Handler> = Handler extends (
  input: any,
  lifecycle: any,
  env: infer E,
) => unknown
  ? E
  : unknown

type CaseValueEnv<Value> = Value extends {
  readonly kind: 'activityCase'
  readonly _env?: (env: infer E) => void
}
  ? E
  : Value extends ActivityImplementation<any, any, infer E>
    ? E
    : Value extends { readonly handler: infer Handler }
      ? HandlerEnv<Handler>
      : HandlerEnv<Value>

// An env-less handler passed to the `activity` helper infers `any` from the
// helper's contextual return type; like `unknown`, that requires nothing.
type Required<E> = 0 extends 1 & E ? unknown : E

// Every case's env at once; runnable cases and env-less handlers add nothing.
type CaseEnv<Cases> = {
  [K in keyof Cases]: (env: Required<CaseValueEnv<Cases[K]>>) => void
}[keyof Cases] extends (env: infer All) => void
  ? All
  : unknown

type CaseImplementationFactory<
  Cases extends Record<string, BranchCaseDefinition>,
  Outputs extends object,
  Input,
  Values extends CaseImplementationObject<Cases, Input> =
    CaseImplementationObject<Cases, Input>,
> = (helpers: CaseImplementers<Outputs, Input>) => Values

type CaseImplementationArgument<
  Cases extends Record<string, BranchCaseDefinition>,
  Outputs extends object,
  Input,
  Values extends CaseImplementationObject<Cases, Input> =
    CaseImplementationObject<Cases, Input>,
> = Values | CaseImplementationFactory<Cases, Outputs, Input, Values>

export type ItemOfMapNode<Node> = Node extends {
  readonly _types?: { readonly input: infer Input }
}
  ? Input extends readonly (infer Item)[]
    ? Item
    : never
  : never

export type NodeOutput<Node> = Node extends {
  readonly name: infer Name extends string
  readonly _types?: { readonly output: infer Output }
}
  ? { readonly [Key in Name]: Output }
  : {}

export type WorkflowImplementationChain<
  Workflow extends AnyWorkflowDefinition,
  WorkflowEnv,
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
        readonly [Key in Name]: <Env = unknown>(
          value: ActivityImplementationValue<Input, Output, Env>,
          ...options: WorkflowInputMapperArguments<Outputs, WorkflowArgs, Input>
        ) => WorkflowImplementationChain<
          Workflow,
          WorkflowEnv & Env,
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
            ...options: WorkflowInputMapperArguments<
              Outputs,
              WorkflowArgs,
              TaskInput<Task>
            >
          ) => WorkflowImplementationChain<
            Workflow,
            WorkflowEnv,
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
              ...options: WorkflowInputMapperArguments<
                Outputs,
                WorkflowArgs,
                WorkflowInput<Child>
              >
            ) => WorkflowImplementationChain<
              Workflow,
              WorkflowEnv,
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
                const Values extends CaseImplementationObject<
                  Cases,
                  WorkflowArgs
                >,
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
                WorkflowEnv & CaseEnv<Values>,
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
                  const Values extends CaseImplementationObject<
                    Cases,
                    WorkflowArgs
                  >,
                >(
                  cases: CaseImplementationArgument<
                    Cases,
                    Outputs,
                    WorkflowArgs,
                    Values
                  >,
                ) => WorkflowImplementationChain<
                  Workflow,
                  WorkflowEnv & CaseEnv<Values>,
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
                    WorkflowEnv,
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
                      WorkflowEnv,
                      Rest,
                      Outputs & NodeOutput<Node>,
                      WorkflowArgs,
                      Result
                    >
                  }
                : WorkflowImplementationChain<
                    Workflow,
                    WorkflowEnv,
                    Rest,
                    Outputs,
                    WorkflowArgs,
                    Result
                  >
  : {
      readonly finish: <Env = unknown>(
        finish: FinishHandler<Env, Outputs, WorkflowArgs, Result>,
      ) => WorkflowImplementation<Workflow, WorkflowEnv & Env>
    }

export type WorkflowImplementer<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowEnv = unknown,
> = WorkflowImplementationChain<
  Workflow,
  WorkflowEnv,
  WorkflowNodes<Workflow>,
  {},
  WorkflowInput<Workflow>,
  WorkflowOutput<Workflow>
>

export type WorkflowImplementationOptions = {
  /**
   * The execution pool whose workers run this workflow's activities. The
   * workflow itself is advanced by coordinators; tasks and child workflows it
   * uses run where their own implementations say.
   */
  readonly pool: string
}

export function implementWorkflow<
  Workflow extends AnyWorkflowDefinition,
  WorkflowEnv = unknown,
>(
  workflow: Workflow,
  options: WorkflowImplementationOptions,
): WorkflowImplementer<Workflow, WorkflowEnv> {
  return createImplementationChain(workflow, options) as WorkflowImplementer<
    Workflow,
    WorkflowEnv
  >
}

/**
 * How an adapter's handlers become the stored ones. Its chain has its own
 * types: TypeScript cannot infer a handler's requirement through a type-level
 * function, so the handler shape is not a parameter of the chain above.
 */
export type HandlerAdapter = {
  readonly handler: (written: never) => ActivityHandler<any, any, any>
  readonly finish: (written: never) => FinishHandler<any, any, any, any>
}

const storedHandlers: HandlerAdapter = {
  handler: (written) => written,
  finish: (written) => written,
}

export function createImplementationChain(
  workflow: AnyWorkflowDefinition,
  options: WorkflowImplementationOptions,
  adapter: HandlerAdapter = storedHandlers,
): unknown {
  return createWorkflowChain({
    workflow,
    pool: options.pool,
    adapter,
    index: 0,
    implementations: [],
  })
}

type ChainState = {
  workflow: AnyWorkflowDefinition
  pool: string
  adapter: HandlerAdapter
  index: number
  implementations: readonly WorkflowNodeImplementation[]
}

function createWorkflowChain(state: ChainState): unknown {
  const node = state.workflow.nodes[state.index]

  if (!node) {
    return Object.freeze({
      finish: (finish: never) =>
        Object.freeze({
          kind: 'workflowImplementation',
          workflow: state.workflow,
          pool: state.pool,
          nodes: Object.freeze([...state.implementations]),
          finish: state.adapter.finish(finish),
        }),
    })
  }

  switch (node.kind) {
    case 'activity':
      return Object.freeze({
        [node.name]: (
          value: ActivityImplementationValue<unknown, unknown>,
          options?: ActivityImplementationOptions<any, any, any>,
        ) =>
          nextChain(state, {
            kind: 'activity',
            name: node.name,
            activity: createActivityImplementation(
              state.adapter,
              node.name,
              value,
            ),
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
            cases: Object.freeze(normalizeCases(state.adapter, node, cases)),
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
            cases: Object.freeze(normalizeCases(state.adapter, node, cases)),
          })
        },
      })
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

function createCaseImplementers(): CaseImplementers<any, any> {
  const helpers: CaseImplementers<any, any> = {
    activity: <NodeInput, Output, Env = unknown>(
      value: ActivityImplementationValue<NodeInput, Output, Env>,
      options?: ActivityImplementationOptions<any, any, NodeInput>,
    ) =>
      Object.freeze({
        kind: 'activityCase',
        value,
        options,
      }) as ActivityCaseDescriptor<NodeInput, Output, Env>,
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

const reservedCaseKeys = new Set(['__proto__', 'constructor', 'prototype'])

function normalizeCases(
  adapter: HandlerAdapter,
  node: WorkflowBranchNode | WorkflowParallelNode,
  cases: Record<string, unknown>,
): Record<string, WorkflowCaseImplementation> {
  const implementations: Record<string, WorkflowCaseImplementation> =
    Object.create(null)

  for (const caseName in node.cases) {
    if (Object.hasOwn(node.cases, caseName) === false) continue
    // Plain definitions can bypass the builders. Keep rejecting keys that
    // cross JSON, jsonb, Lua/cjson, schema libraries and user code, where
    // handling of `__proto__` is outside our control.
    if (reservedCaseKeys.has(caseName)) {
      throw new Error(
        `Workflow ${node.kind} case key cannot be "${caseName}": ${node.name}`,
      )
    }
    if (Object.hasOwn(cases, caseName) === false) {
      throw new Error(
        `Missing workflow ${node.kind} case implementation [${node.name}.${caseName}]`,
      )
    }

    implementations[caseName] = normalizeCase(
      adapter,
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
  adapter: HandlerAdapter,
  name: string,
  branchCase: BranchCaseDefinition,
  value: unknown,
): WorkflowCaseImplementation {
  if (branchCase.kind === 'activity') {
    const descriptor = isActivityCaseDescriptor(value) ? value : undefined
    return Object.freeze({
      kind: 'activity',
      name,
      activity: createActivityImplementation(
        adapter,
        name,
        descriptor?.value ?? value,
      ),
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
  adapter: HandlerAdapter,
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
    handler: adapter.handler(handler as never),
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
