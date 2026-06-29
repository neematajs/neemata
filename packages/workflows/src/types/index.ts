import type { BaseTypeAny, t } from '@nmtjs/type'

export type MaybePromise<T> = T | Promise<T>

export type DurationString = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export type RetryPolicy = {
  attempts: number
  backoff?: 'fixed' | 'exponential'
  delay?: DurationString
}

export type IdempotencyConflictPolicy = 'return-existing' | 'fail'

export type IdempotencyKey = readonly unknown[]

export type CancellationPolicy = 'propagate' | 'detach'

export type WorkflowStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type TaskStatus = WorkflowStatus

export type RunKind = 'workflow' | 'task'

export type Schema = BaseTypeAny

export type SchemaInput<T extends Schema> = t.infer.decode.output<T>

export type SchemaOutput<T extends Schema> = t.infer.decode.output<T>

export type TaskDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
> = {
  readonly kind: 'task'
  readonly name: Name
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  readonly timeout?: DurationString
  readonly _types?: { readonly input: Input; readonly output: Output }
}

export type AnyTaskDefinition = TaskDefinition<string, any, any>

export type TaskInput<T> =
  T extends TaskDefinition<string, infer Input, any> ? Input : never

export type TaskOutput<T> =
  T extends TaskDefinition<string, any, infer Output> ? Output : never

export type ActivityBinding<Input = unknown, Output = unknown> = {
  readonly input: Input
  readonly output: Output
}

export type ActivityBindings = Record<string, ActivityBinding<any, any>>

export type WorkflowNodeKind =
  | 'activity'
  | 'task'
  | 'workflow'
  | 'branch'
  | 'parallel'
  | 'mapTask'
  | 'mapWorkflow'

export type WorkflowNodeBase<
  Kind extends WorkflowNodeKind = WorkflowNodeKind,
  Name extends string = string,
> = {
  readonly kind: Kind
  readonly name: Name
}

export type WorkflowActivityNode<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  _Scope = any,
> = WorkflowNodeBase<'activity', Name> & {
  readonly kind: 'activity'
  readonly name: Name
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<Input, Output>
}

export type WorkflowTaskNode<
  Name extends string = string,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  _Scope = any,
> = WorkflowNodeBase<'task', Name> & {
  readonly task: Task
  readonly retry?: RetryPolicy
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<TaskInput<Task>, TaskOutput<Task>>
}

export type WorkflowChildWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  _Scope = any,
> = WorkflowNodeBase<'workflow', Name> & {
  readonly workflow: Workflow
  readonly cancellation?: CancellationPolicy
  readonly _types?: ActivityBinding<
    WorkflowInput<Workflow>,
    WorkflowOutput<Workflow>
  >
}

export type WorkflowBranchNode<
  Name extends string = string,
  Cases extends Record<string, BranchCaseDefinition> = Record<
    string,
    BranchCaseDefinition
  >,
  _Scope = any,
  Output = unknown,
> = WorkflowNodeBase<'branch', Name> & {
  readonly kind: 'branch'
  readonly name: Name
  readonly output?: Schema
  readonly cases: Cases
  readonly _types?: ActivityBinding<unknown, Output>
}

export type WorkflowParallelNode<
  Name extends string = string,
  Cases extends Record<string, BranchCaseDefinition> = Record<
    string,
    BranchCaseDefinition
  >,
  _Scope = any,
  Output = unknown,
> = WorkflowNodeBase<'parallel', Name> & {
  readonly kind: 'parallel'
  readonly name: Name
  readonly cases: Cases
  readonly _types?: ActivityBinding<unknown, Output>
}

export type MapRunMode = 'start-only' | 'wait-all' | 'wait-settled'

export type MapStartOnlyOutput<Item> = {
  readonly items: Array<{
    readonly item: Item
    readonly index: number
    readonly runId: string
    readonly status: WorkflowStatus
  }>
}

export type MapWaitAllOutput<Item, Output> = {
  readonly items: Array<{
    readonly item: Item
    readonly index: number
    readonly runId: string
    readonly output: Output
  }>
}

export type MapWaitSettledOutput<Item, Output> = {
  readonly items: Array<{
    readonly item: Item
    readonly index: number
    readonly runId: string
    readonly status: WorkflowStatus
    readonly output?: Output
    readonly error?: unknown
  }>
}

export type MapNodeOutput<
  Mode extends MapRunMode,
  Item,
  Output,
> = Mode extends 'start-only'
  ? MapStartOnlyOutput<Item>
  : Mode extends 'wait-all'
    ? MapWaitAllOutput<Item, Output>
    : MapWaitSettledOutput<Item, Output>

export type WorkflowMapTaskNode<
  Name extends string = string,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Item = unknown,
  Mode extends MapRunMode = MapRunMode,
  _Scope = any,
> = WorkflowNodeBase<'mapTask', Name> & {
  readonly task: Task
  readonly item: Schema
  readonly mode: Mode
  readonly concurrency?: number
  readonly retry?: RetryPolicy
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<
    readonly Item[],
    MapNodeOutput<Mode, Item, TaskOutput<Task>>
  >
}

export type WorkflowMapWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  Item = unknown,
  Mode extends MapRunMode = MapRunMode,
  _Scope = any,
> = WorkflowNodeBase<'mapWorkflow', Name> & {
  readonly workflow: Workflow
  readonly item: Schema
  readonly mode: Mode
  readonly concurrency?: number
  readonly cancellation?: CancellationPolicy
  readonly _types?: ActivityBinding<
    readonly Item[],
    MapNodeOutput<Mode, Item, WorkflowOutput<Workflow>>
  >
}

export type BranchCaseKind = 'activity' | 'task' | 'workflow'

export type BranchCaseDefinition<
  Kind extends BranchCaseKind = BranchCaseKind,
  Input = unknown,
  Output = unknown,
  Target = unknown,
  _Scope = any,
> = {
  readonly kind: Kind
  readonly _types?: { readonly input: Input; readonly output: Output }
} & (Kind extends 'activity'
  ? {
      readonly input: Schema
      readonly output: Schema
      readonly retry?: RetryPolicy
      readonly timeout?: DurationString
    }
  : Kind extends 'task'
    ? {
        readonly target: Target extends AnyTaskDefinition
          ? Target
          : AnyTaskDefinition
        readonly retry?: RetryPolicy
        readonly timeout?: DurationString
      }
    : Kind extends 'workflow'
      ? {
          readonly target: Target extends AnyWorkflowDefinition
            ? Target
            : AnyWorkflowDefinition
          readonly cancellation?: CancellationPolicy
        }
      : never)

export type WorkflowNode =
  | WorkflowActivityNode
  | WorkflowTaskNode
  | WorkflowChildWorkflowNode
  | WorkflowBranchNode
  | WorkflowParallelNode
  | WorkflowMapTaskNode
  | WorkflowMapWorkflowNode

export type BranchCaseOutput<T> =
  T extends BranchCaseDefinition<any, any, infer Output> ? Output : never

export type BranchCaseOutputs<
  Cases extends Record<string, BranchCaseDefinition>,
> = {
  readonly [CaseName in keyof Cases]: BranchCaseOutput<Cases[CaseName]>
}

export type BranchCaseOutputUnion<
  Cases extends Record<string, BranchCaseDefinition>,
> = BranchCaseOutput<Cases[keyof Cases]>

export type BranchActivityBindings<
  BranchName extends string,
  Cases extends Record<string, BranchCaseDefinition>,
> = {
  [CaseName in keyof Cases as Cases[CaseName] extends BranchCaseDefinition<
    'activity',
    any,
    any
  >
    ? `${BranchName}.${CaseName & string}`
    : never]: Cases[CaseName] extends BranchCaseDefinition<
    'activity',
    infer Input,
    infer Output
  >
    ? ActivityBinding<Input, Output>
    : never
}

export type WorkflowDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Nodes extends readonly WorkflowNode[] = readonly WorkflowNode[],
  Activities extends ActivityBindings = ActivityBindings,
> = {
  readonly kind: 'workflow'
  readonly name: Name
  readonly input: Schema
  readonly output?: Schema
  readonly nodes: Nodes
  readonly retention?: DurationString
  readonly _types?: {
    readonly input: Input
    readonly output: Output
    readonly activities: Activities
  }
}

export type AnyWorkflowDefinition = WorkflowDefinition<
  string,
  any,
  any,
  readonly WorkflowNode[],
  ActivityBindings
>

export type WorkflowInput<T> =
  T extends WorkflowDefinition<string, infer Input, any, any, any>
    ? Input
    : never

export type WorkflowOutput<T> =
  T extends WorkflowDefinition<string, any, infer Output, any, any>
    ? Output
    : never

export type WorkflowActivities<T> =
  T extends WorkflowDefinition<string, any, any, any, infer Activities>
    ? Activities
    : never

export type WorkflowNodes<T> =
  T extends WorkflowDefinition<string, any, any, infer Nodes, any>
    ? Nodes
    : never

export type WorkflowRun<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> = {
  id: string
  kind: 'workflow'
  workflow: Workflow['name']
  status: WorkflowStatus
  input: WorkflowInput<Workflow>
  output?: WorkflowOutput<Workflow>
}

export type TaskRun<Task extends AnyTaskDefinition = AnyTaskDefinition> = {
  id: string
  kind: 'task'
  task: Task['name']
  status: TaskStatus
  input: TaskInput<Task>
  output?: TaskOutput<Task>
}

export type RunnableRun<
  Runnable extends AnyWorkflowDefinition | AnyTaskDefinition =
    | AnyWorkflowDefinition
    | AnyTaskDefinition,
> = Runnable extends AnyWorkflowDefinition
  ? WorkflowRun<Runnable>
  : Runnable extends AnyTaskDefinition
    ? TaskRun<Runnable>
    : never

export type RunnableInput<
  Runnable extends AnyWorkflowDefinition | AnyTaskDefinition,
> = Runnable extends AnyWorkflowDefinition
  ? WorkflowInput<Runnable>
  : Runnable extends AnyTaskDefinition
    ? TaskInput<Runnable>
    : never

export type WorkflowClient = {
  start<Runnable extends AnyWorkflowDefinition | AnyTaskDefinition>(
    runnable: Runnable,
    input: RunnableInput<Runnable>,
    options?: { idempotencyKey?: IdempotencyKey },
  ): Promise<RunnableRun<Runnable>>
  get<Runnable extends AnyWorkflowDefinition | AnyTaskDefinition>(
    runnable: Runnable,
    runId: string,
  ): Promise<RunnableRun<Runnable> | undefined>
  list<Runnable extends AnyWorkflowDefinition | AnyTaskDefinition>(
    runnable: Runnable,
    filter?: { status?: WorkflowStatus },
  ): Promise<RunnableRun<Runnable>[]>
  cancel<Runnable extends AnyWorkflowDefinition | AnyTaskDefinition>(
    runnable: Runnable,
    runId: string,
    options?: { reason?: string },
  ): Promise<RunnableRun<Runnable>>
}
