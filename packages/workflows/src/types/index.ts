import type { BaseTypeAny, t } from '@nmtjs/type'

export type MaybePromise<T> = T | Promise<T>

export type DurationString = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export type RetryPolicy = {
  attempts: number
  backoff?: 'fixed' | 'exponential'
  delay?: DurationString
}

export type IdempotencyKey = readonly unknown[]

export type CancellationPolicy = 'propagate' | 'detach'

export type WorkflowStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type TaskStatus = WorkflowStatus

export type RunKind = 'workflow' | 'task'

export type Schema = BaseTypeAny

export type SchemaInput<T extends Schema> = t.infer.decode.input<T>

export type SchemaOutput<T extends Schema> = t.infer.decode.output<T>

export type SchemaBoundary<In = unknown, Out = In> = {
  readonly in: In
  readonly out: Out
}

export type BoundaryInput<T> = T extends { readonly in: infer Input }
  ? Input
  : T

export type BoundaryOutput<T> = T extends { readonly out: infer Output }
  ? Output
  : T

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
  /** Default timeout for task attempts unless a workflow task/map/branch member overrides it. */
  readonly timeout?: DurationString
  readonly _types?: { readonly input: Input; readonly output: Output }
}

export type AnyTaskDefinition = TaskDefinition<string, any, any>

type TaskInputBoundary<T> =
  T extends TaskDefinition<string, infer Input, any> ? Input : never

type TaskOutputBoundary<T> =
  T extends TaskDefinition<string, any, infer Output> ? Output : never

export type TaskInput<T> = BoundaryInput<TaskInputBoundary<T>>

export type TaskDecodedInput<T> = BoundaryOutput<TaskInputBoundary<T>>

export type TaskOutputInput<T> = BoundaryInput<TaskOutputBoundary<T>>

export type TaskOutput<T> = BoundaryOutput<TaskOutputBoundary<T>>

export type ActivityBinding<Input = unknown, Output = unknown> = {
  readonly input: Input
  readonly output: Output
}

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
> = WorkflowNodeBase<'activity', Name> & {
  readonly kind: 'activity'
  readonly name: Name
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  /** Timeout for this activity attempt. */
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<Input, Output>
}

export type WorkflowTaskNode<
  Name extends string = string,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
> = WorkflowNodeBase<'task', Name> & {
  readonly task: Task
  readonly retry?: RetryPolicy
  /** Overrides the target task's default timeout for this workflow task node. */
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<TaskInput<Task>, TaskOutput<Task>>
}

export type WorkflowChildWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
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
    readonly error?: WorkflowSettledError
  }>
}

export type WorkflowSettledError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
  readonly cause?: WorkflowSettledError
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
> = WorkflowNodeBase<'mapTask', Name> & {
  readonly task: Task
  readonly item: Schema
  readonly mode: Mode
  readonly concurrency?: number
  readonly retry?: RetryPolicy
  /** Overrides the target task's default timeout for every map task item. */
  readonly timeout?: DurationString
  readonly _types?: ActivityBinding<
    SchemaBoundary<
      readonly BoundaryInput<Item>[],
      readonly BoundaryOutput<Item>[]
    >,
    MapNodeOutput<Mode, BoundaryOutput<Item>, TaskOutput<Task>>
  >
}

export type WorkflowMapWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  Item = unknown,
  Mode extends MapRunMode = MapRunMode,
> = WorkflowNodeBase<'mapWorkflow', Name> & {
  readonly workflow: Workflow
  readonly item: Schema
  readonly mode: Mode
  readonly concurrency?: number
  readonly cancellation?: CancellationPolicy
  readonly _types?: ActivityBinding<
    SchemaBoundary<
      readonly BoundaryInput<Item>[],
      readonly BoundaryOutput<Item>[]
    >,
    MapNodeOutput<Mode, BoundaryOutput<Item>, WorkflowOutput<Workflow>>
  >
}

export type BranchCaseKind = 'activity' | 'task' | 'workflow'

export type BranchCaseDefinition<
  Kind extends BranchCaseKind = BranchCaseKind,
  Input = unknown,
  Output = unknown,
  Target = unknown,
> = {
  readonly kind: Kind
  readonly _types?: { readonly input: Input; readonly output: Output }
} & (Kind extends 'activity'
  ? {
      readonly input: Schema
      readonly output: Schema
      readonly retry?: RetryPolicy
      /** Timeout for this branch or parallel activity member. */
      readonly timeout?: DurationString
    }
  : Kind extends 'task'
    ? {
        readonly target: Target extends AnyTaskDefinition
          ? Target
          : AnyTaskDefinition
        readonly retry?: RetryPolicy
        /** Overrides the target task's default timeout for this branch or parallel task member. */
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
  T extends BranchCaseDefinition<any, any, infer Output>
    ? BoundaryOutput<Output>
    : never

export type BranchCaseOutputs<
  Cases extends Record<string, BranchCaseDefinition>,
> = {
  readonly [CaseName in keyof Cases]: BranchCaseOutput<Cases[CaseName]>
}

export type BranchCaseOutputUnion<
  Cases extends Record<string, BranchCaseDefinition>,
> = BranchCaseOutput<Cases[keyof Cases]>

export type WorkflowDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Nodes extends readonly WorkflowNode[] = readonly WorkflowNode[],
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
  }
}

export type AnyWorkflowDefinition = WorkflowDefinition<
  string,
  any,
  any,
  readonly WorkflowNode[]
>

type WorkflowInputBoundary<T> =
  T extends WorkflowDefinition<string, infer Input, any, any> ? Input : never

type WorkflowOutputBoundary<T> =
  T extends WorkflowDefinition<string, any, infer Output, any> ? Output : never

export type WorkflowInput<T> = BoundaryInput<WorkflowInputBoundary<T>>

export type WorkflowDecodedInput<T> = BoundaryOutput<WorkflowInputBoundary<T>>

export type WorkflowOutputInput<T> = BoundaryInput<WorkflowOutputBoundary<T>>

export type WorkflowOutput<T> = BoundaryOutput<WorkflowOutputBoundary<T>>

export type WorkflowNodes<T> =
  T extends WorkflowDefinition<string, any, any, infer Nodes> ? Nodes : never

export type WorkflowRun<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> = {
  readonly id: string
  readonly kind: 'workflow'
  readonly name: Workflow['name']
  readonly status: WorkflowStatus
  readonly input: WorkflowDecodedInput<Workflow>
  readonly output?: WorkflowOutput<Workflow>
  readonly error?: unknown
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId: string
  readonly tags: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type TaskRun<Task extends AnyTaskDefinition = AnyTaskDefinition> = {
  readonly id: string
  readonly kind: 'task'
  readonly name: Task['name']
  readonly status: TaskStatus
  readonly input: TaskDecodedInput<Task>
  readonly output?: TaskOutput<Task>
  readonly error?: unknown
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId: string
  readonly tags: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
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
