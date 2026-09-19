import type { MaybePromise } from '@nmtjs/common'
import type { BaseTypeAny, t } from '@nmtjs/type'

export type { MaybePromise }

export type DurationString = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export type RetryPolicy = {
  attempts: number
  backoff?: 'fixed' | 'exponential'
  delay?: DurationString
}

export type IdempotencyKey = readonly unknown[]

export type RunTags = Readonly<Record<string, string>>

export type RunTagsBuilder<Input> = (input: BoundaryOutput<Input>) => RunTags

export type RunIdempotencyBuilder<Input> = (
  input: BoundaryOutput<Input>,
) => IdempotencyKey

export type RunUniqueScope = 'active' | 'all'

export type RunUniqueBehavior = 'reject' | 'join'

/**
 * Start-time uniqueness constraint over root runs. `scope: 'active'` allows
 * at most one non-terminal run per key — the key frees up once that run
 * completes, fails or cancels (a `cancelling` run still holds it). `scope:
 * 'all'` allows one run per key ever. On conflict, `reject` throws a
 * WorkflowRunConflictError and `join` returns the conflicting run — without
 * comparing inputs, unlike `idempotencyKey`.
 */
export type RunUniqueConstraint = {
  readonly key: readonly unknown[]
  /** @default 'active' */
  readonly scope?: RunUniqueScope
  /** @default 'reject' */
  readonly behavior?: RunUniqueBehavior
}

export type ResolvedRunUnique = {
  readonly key: readonly unknown[]
  readonly scope: RunUniqueScope
  readonly behavior: RunUniqueBehavior
}

export type RunUniqueBuilder<Input> =
  | ((input: BoundaryOutput<Input>) => readonly unknown[])
  | {
      readonly key: (input: BoundaryOutput<Input>) => readonly unknown[]
      readonly scope?: RunUniqueScope
      readonly behavior?: RunUniqueBehavior
    }

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

/** Phantom carrier: definitions keep their input/output types in `_types`. */
export type PhantomIO<Input = unknown, Output = unknown> = {
  readonly input: Input
  readonly output: Output
}

export type TaskDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
> = {
  readonly kind: 'task'
  readonly name: Name
  readonly title?: string
  readonly description?: string
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  /** Default timeout for task attempts unless a workflow task/map/branch member overrides it. */
  readonly timeout?: DurationString
  readonly tags?: RunTagsBuilder<Input>
  readonly idempotency?: RunIdempotencyBuilder<Input>
  /** Enforced for root starts through the runtime client; child dispatch is unaffected. */
  readonly unique?: RunUniqueBuilder<Input>
  readonly _types?: PhantomIO<Input, Output>
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
  readonly title?: string
  readonly description?: string
}

export type WorkflowActivityNode<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
> = WorkflowNodeBase<'activity', Name> & {
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  /** Timeout for this activity attempt. */
  readonly timeout?: DurationString
  readonly _types?: PhantomIO<Input, Output>
}

export type WorkflowTaskNode<
  Name extends string = string,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
> = WorkflowNodeBase<'task', Name> & {
  readonly task: Task
  readonly retry?: RetryPolicy
  /** Overrides the target task's default timeout for this workflow task node. */
  readonly timeout?: DurationString
  readonly _types?: PhantomIO<TaskInput<Task>, TaskOutput<Task>>
}

export type WorkflowChildWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> = WorkflowNodeBase<'workflow', Name> & {
  readonly workflow: Workflow
  readonly cancellation?: CancellationPolicy
  readonly _types?: PhantomIO<WorkflowInput<Workflow>, WorkflowOutput<Workflow>>
}

export type WorkflowBranchNode<
  Name extends string = string,
  Cases extends BranchCases = BranchCases,
  Output = unknown,
> = WorkflowNodeBase<'branch', Name> & {
  readonly output?: Schema
  readonly cases: Cases
  readonly _types?: PhantomIO<unknown, Output>
}

export type WorkflowParallelNode<
  Name extends string = string,
  Cases extends BranchCases = BranchCases,
  Output = unknown,
> = WorkflowNodeBase<'parallel', Name> & {
  readonly cases: Cases
  readonly _types?: PhantomIO<unknown, Output>
}

export type MapNodeOutput<Item, Output> = {
  readonly items: Array<{
    readonly item: Item
    readonly index: number
    readonly runId: string
    readonly output: Output
  }>
}

export type WorkflowMapTaskNode<
  Name extends string = string,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
  Item = unknown,
> = WorkflowNodeBase<'mapTask', Name> & {
  readonly task: Task
  readonly item: Schema
  readonly concurrency?: number
  readonly retry?: RetryPolicy
  /** Overrides the target task's default timeout for every map task item. */
  readonly timeout?: DurationString
  readonly _types?: PhantomIO<
    SchemaBoundary<
      readonly BoundaryInput<Item>[],
      readonly BoundaryOutput<Item>[]
    >,
    MapNodeOutput<BoundaryOutput<Item>, TaskOutput<Task>>
  >
}

export type WorkflowMapWorkflowNode<
  Name extends string = string,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  Item = unknown,
> = WorkflowNodeBase<'mapWorkflow', Name> & {
  readonly workflow: Workflow
  readonly item: Schema
  readonly concurrency?: number
  readonly cancellation?: CancellationPolicy
  readonly _types?: PhantomIO<
    SchemaBoundary<
      readonly BoundaryInput<Item>[],
      readonly BoundaryOutput<Item>[]
    >,
    MapNodeOutput<BoundaryOutput<Item>, WorkflowOutput<Workflow>>
  >
}

export type BranchCaseKind = 'activity' | 'task' | 'workflow'

type BranchCaseBase<Kind extends BranchCaseKind, Input, Output> = {
  readonly kind: Kind
  readonly title?: string
  readonly description?: string
  readonly _types?: PhantomIO<Input, Output>
}

export type ActivityCaseDefinition<
  Input = unknown,
  Output = unknown,
> = BranchCaseBase<'activity', Input, Output> & {
  readonly input: Schema
  readonly output: Schema
  readonly retry?: RetryPolicy
  /** Timeout for this branch or parallel activity member. */
  readonly timeout?: DurationString
}

export type TaskCaseDefinition<
  Input = unknown,
  Output = unknown,
  Task extends AnyTaskDefinition = AnyTaskDefinition,
> = BranchCaseBase<'task', Input, Output> & {
  readonly target: Task
  readonly retry?: RetryPolicy
  /** Overrides the target task's default timeout for this branch or parallel task member. */
  readonly timeout?: DurationString
}

export type WorkflowCaseDefinition<
  Input = unknown,
  Output = unknown,
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> = BranchCaseBase<'workflow', Input, Output> & {
  readonly target: Workflow
  readonly cancellation?: CancellationPolicy
}

/**
 * Distributes over `Kind` so the default parameter yields a discriminated
 * union that narrows on `kind`.
 */
export type BranchCaseDefinition<
  Kind extends BranchCaseKind = BranchCaseKind,
  Input = unknown,
  Output = unknown,
  Target = unknown,
> = Kind extends 'activity'
  ? ActivityCaseDefinition<Input, Output>
  : Kind extends 'task'
    ? TaskCaseDefinition<
        Input,
        Output,
        Target extends AnyTaskDefinition ? Target : AnyTaskDefinition
      >
    : WorkflowCaseDefinition<
        Input,
        Output,
        Target extends AnyWorkflowDefinition ? Target : AnyWorkflowDefinition
      >

export type BranchCases = Record<string, BranchCaseDefinition>

export type WorkflowNode =
  | WorkflowActivityNode
  | WorkflowTaskNode
  | WorkflowChildWorkflowNode
  | WorkflowBranchNode
  | WorkflowParallelNode
  | WorkflowMapTaskNode
  | WorkflowMapWorkflowNode

export type BranchCaseOutput<T> = T extends {
  readonly _types?: PhantomIO<any, infer Output>
}
  ? BoundaryOutput<Output>
  : never

export type BranchCaseOutputs<Cases extends BranchCases> = {
  readonly [CaseName in keyof Cases]: BranchCaseOutput<Cases[CaseName]>
}

export type BranchCaseOutputUnion<Cases extends BranchCases> = BranchCaseOutput<
  Cases[keyof Cases]
>

export type WorkflowDefinition<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Nodes extends readonly WorkflowNode[] = readonly WorkflowNode[],
> = {
  readonly kind: 'workflow'
  readonly name: Name
  readonly title?: string
  readonly description?: string
  readonly input: Schema
  readonly output?: Schema
  readonly nodes: Nodes
  readonly retention?: DurationString
  /**
   * Backstop for stuck runs: a non-terminal run older than this is failed by
   * the worker maintenance sweep and its children are cancelled.
   */
  readonly timeout?: DurationString
  readonly tags?: RunTagsBuilder<Input>
  readonly idempotency?: RunIdempotencyBuilder<Input>
  /** Enforced for root starts through the runtime client; child dispatch is unaffected. */
  readonly unique?: RunUniqueBuilder<Input>
  readonly _types?: PhantomIO<Input, Output>
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

type RunBase = {
  readonly id: string
  readonly status: WorkflowStatus
  readonly error?: unknown
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId: string
  readonly tags: RunTags
  readonly idempotencyKey?: IdempotencyKey
  readonly unique?: ResolvedRunUnique
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type WorkflowRun<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
> = RunBase & {
  readonly kind: 'workflow'
  readonly name: Workflow['name']
  readonly input: WorkflowDecodedInput<Workflow>
  readonly output?: WorkflowOutput<Workflow>
}

export type TaskRun<Task extends AnyTaskDefinition = AnyTaskDefinition> =
  RunBase & {
    readonly kind: 'task'
    readonly name: Task['name']
    readonly input: TaskDecodedInput<Task>
    readonly output?: TaskOutput<Task>
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

export type RunnableDefinition = AnyWorkflowDefinition | AnyTaskDefinition

export type RunnableInput<Runnable extends RunnableDefinition> =
  Runnable extends AnyWorkflowDefinition
    ? WorkflowInput<Runnable>
    : Runnable extends AnyTaskDefinition
      ? TaskInput<Runnable>
      : never

export type ScheduleDefinition<
  Name extends string = string,
  Runnable extends RunnableDefinition = RunnableDefinition,
> = {
  readonly kind: 'schedule'
  readonly name: Name
  readonly runnable: Runnable
  readonly input: RunnableInput<Runnable>
  readonly cron?: string
  readonly every?: DurationString
  readonly tags?: RunTags
  readonly enabled: boolean
  readonly immediately?: boolean
}

export type AnyScheduleDefinition = ScheduleDefinition<
  string,
  RunnableDefinition
>
