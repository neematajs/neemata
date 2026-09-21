import { CronExpressionParser } from 'cron-parser'

import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  BranchCaseOutputUnion,
  BranchCaseOutputs,
  CancellationPolicy,
  DurationString,
  RunIdempotencyBuilder,
  RunTagsBuilder,
  RunUniqueBuilder,
  RetryPolicy,
  RunnableDefinition,
  RunnableInput,
  ScheduleDefinition,
  CodecKind,
  Schema,
  SchemaBound,
  SchemaKind,
  SchemaType,
  TaskDefinition,
  TaskInput,
  TaskOutput,
  WorkflowActivityNode,
  WorkflowBranchNode,
  WorkflowChildWorkflowNode,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowMapTaskNode,
  WorkflowMapWorkflowNode,
  WorkflowNode,
  WorkflowOutput,
  WorkflowParallelNode,
  WorkflowTaskNode,
} from '../types/index.ts'
import { parseDurationMs } from '../runtime/duration.ts'

declare const noDeclaredOutput: unique symbol
type NoDeclaredOutput = { readonly [noDeclaredOutput]: true }

type AvailableNodeName<Name extends string> = Name extends 'input'
  ? never
  : Name

type BranchCaseMap = Record<string, BranchCaseDefinition>

type LeafCaseMap = Record<string, BranchCaseDefinition>

type BranchActivityCaseOptions<
  K extends SchemaKind,
  BranchOutput,
  InputSchema,
  OutputSchema,
> = {
  input: InputSchema
  output: OutputSchema
  title?: string
  description?: string
  retry?: RetryPolicy
  timeout?: DurationString
} & (OutputSchema extends SchemaBound<K>
  ? OutputMatches<
      SchemaType<K, OutputSchema>,
      BranchOutput,
      'activity case output does not satisfy branch output'
    >
  : OutputMismatch<
      'activity case output does not satisfy branch output',
      BranchOutput,
      unknown
    >)

declare const outputMismatch: unique symbol
type OutputMismatch<Message extends string, Expected, Received> = {
  readonly [outputMismatch]: Message
  readonly expected: Expected
  readonly received: Received
}

type OutputMatches<
  Received,
  Expected,
  Message extends string,
> = Received extends Expected
  ? unknown
  : OutputMismatch<Message, Expected, Received>

export type BranchCaseHelpers<K extends SchemaKind = CodecKind> = {
  activity<
    InputSchema extends SchemaBound<K>,
    OutputSchema extends SchemaBound<K> = SchemaBound<K>,
  >(options: {
    input: InputSchema
    output: OutputSchema
    title?: string
    description?: string
    retry?: RetryPolicy
    timeout?: DurationString
  }): BranchCaseDefinition<
    'activity',
    SchemaType<K, InputSchema>,
    SchemaType<K, OutputSchema>
  >
  task<Task extends AnyTaskDefinition>(
    task: Task,
    options?: {
      title?: string
      description?: string
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): BranchCaseDefinition<'task', TaskInput<Task>, TaskOutput<Task>, Task>
  workflow<Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    options?: {
      title?: string
      description?: string
      cancellation?: CancellationPolicy
    },
  ): BranchCaseDefinition<
    'workflow',
    WorkflowInput<Workflow>,
    WorkflowOutput<Workflow>,
    Workflow
  >
}

export type ConvergedBranchCaseHelpers<K extends SchemaKind, BranchOutput> = {
  activity<
    InputSchema extends SchemaBound<K>,
    OutputSchema extends SchemaBound<K> = SchemaBound<K>,
  >(
    options: BranchActivityCaseOptions<
      K,
      BranchOutput,
      InputSchema,
      OutputSchema
    >,
  ): BranchCaseDefinition<
    'activity',
    SchemaType<K, InputSchema>,
    SchemaType<K, OutputSchema>
  >
  task<Task extends AnyTaskDefinition>(
    task: Task &
      OutputMatches<
        TaskOutput<Task>,
        BranchOutput,
        'task case output does not satisfy branch output'
      >,
    options?: {
      title?: string
      description?: string
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): BranchCaseDefinition<'task', TaskInput<Task>, TaskOutput<Task>, Task>
  workflow<Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow &
      OutputMatches<
        WorkflowOutput<Workflow>,
        BranchOutput,
        'workflow case output does not satisfy branch output'
      >,
    options?: {
      title?: string
      description?: string
      cancellation?: CancellationPolicy
    },
  ): BranchCaseDefinition<
    'workflow',
    WorkflowInput<Workflow>,
    WorkflowOutput<Workflow>,
    Workflow
  >
}

export type WorkflowBuilder<
  Name extends string = string,
  Input = unknown,
  Nodes extends readonly WorkflowNode[] = [],
  DeclaredOutput = NoDeclaredOutput,
  K extends SchemaKind = CodecKind,
> = {
  readonly name: Name
  readonly input: Schema
  readonly output?: Schema
  readonly nodes: Nodes

  activity<
    NodeName extends string,
    InputSchema extends SchemaBound<K>,
    OutputSchema extends SchemaBound<K>,
  >(
    name: AvailableNodeName<NodeName>,
    options: {
      input: InputSchema
      output: OutputSchema
      title?: string
      description?: string
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowActivityNode<
        NodeName,
        SchemaType<K, InputSchema>,
        SchemaType<K, OutputSchema>
      >,
    ],
    DeclaredOutput,
    K
  >

  task<NodeName extends string, Task extends AnyTaskDefinition>(
    name: AvailableNodeName<NodeName>,
    task: Task,
    options?: {
      title?: string
      description?: string
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowTaskNode<NodeName, Task>],
    DeclaredOutput,
    K
  >

  workflow<NodeName extends string, Workflow extends AnyWorkflowDefinition>(
    name: AvailableNodeName<NodeName>,
    workflow: Workflow,
    options?: {
      title?: string
      description?: string
      cancellation?: CancellationPolicy
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowChildWorkflowNode<NodeName, Workflow>],
    DeclaredOutput,
    K
  >

  branch<
    NodeName extends string,
    OutputSchema extends SchemaBound<K>,
    Cases extends BranchCaseMap,
  >(
    name: AvailableNodeName<NodeName>,
    options: {
      output: OutputSchema
      title?: string
      description?: string
      cases: (
        helpers: ConvergedBranchCaseHelpers<K, SchemaType<K, OutputSchema>>,
      ) => Cases
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowBranchNode<NodeName, Cases, SchemaType<K, OutputSchema>>,
    ],
    DeclaredOutput,
    K
  >

  branch<NodeName extends string, Cases extends LeafCaseMap>(
    name: AvailableNodeName<NodeName>,
    options: {
      title?: string
      description?: string
      cases: (helpers: BranchCaseHelpers<K>) => Cases
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowBranchNode<NodeName, Cases, BranchCaseOutputUnion<Cases>>,
    ],
    DeclaredOutput,
    K
  >

  parallel<NodeName extends string, Cases extends LeafCaseMap>(
    name: AvailableNodeName<NodeName>,
    cases: (helpers: BranchCaseHelpers<K>) => Cases,
    options?: {
      title?: string
      description?: string
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowParallelNode<NodeName, Cases, BranchCaseOutputs<Cases>>],
    DeclaredOutput,
    K
  >

  mapTask<
    NodeName extends string,
    Task extends AnyTaskDefinition,
    ItemSchema extends SchemaBound<K>,
  >(
    name: AvailableNodeName<NodeName>,
    task: Task,
    options: {
      item: ItemSchema
      title?: string
      description?: string
      concurrency?: number
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowMapTaskNode<NodeName, Task, SchemaType<K, ItemSchema>>],
    DeclaredOutput,
    K
  >

  mapWorkflow<
    NodeName extends string,
    Workflow extends AnyWorkflowDefinition,
    ItemSchema extends SchemaBound<K>,
  >(
    name: AvailableNodeName<NodeName>,
    workflow: Workflow,
    options: {
      item: ItemSchema
      title?: string
      description?: string
      concurrency?: number
      cancellation?: CancellationPolicy
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowMapWorkflowNode<NodeName, Workflow, SchemaType<K, ItemSchema>>,
    ],
    DeclaredOutput,
    K
  >

  build(): WorkflowDefinition<
    Name,
    Input,
    DeclaredOutput extends NoDeclaredOutput ? unknown : DeclaredOutput,
    Nodes
  >
}

export type TaskOptions<
  K extends SchemaKind,
  Name extends string,
  InputSchema extends SchemaBound<K>,
  OutputSchema extends SchemaBound<K>,
> = {
  name: Name
  title?: string
  description?: string
  input: InputSchema
  output: OutputSchema
  retry?: RetryPolicy
  timeout?: DurationString
  tags?: RunTagsBuilder<SchemaType<K, InputSchema>>
  idempotency?: RunIdempotencyBuilder<SchemaType<K, InputSchema>>
  unique?: RunUniqueBuilder<SchemaType<K, InputSchema>>
}

export type DefineTask<K extends SchemaKind> = <
  Name extends string,
  InputSchema extends SchemaBound<K>,
  OutputSchema extends SchemaBound<K>,
>(
  options: TaskOptions<K, Name, InputSchema, OutputSchema>,
) => TaskDefinition<
  Name,
  SchemaType<K, InputSchema>,
  SchemaType<K, OutputSchema>
>

export type WorkflowOptions<
  K extends SchemaKind,
  Name extends string,
  InputSchema extends SchemaBound<K>,
  OutputSchema extends SchemaBound<K> | undefined,
> = {
  name: Name
  title?: string
  description?: string
  input: InputSchema
  output?: OutputSchema
  retention?: DurationString
  /** Backstop: fail the run (and cancel its children) when it exceeds this age. */
  timeout?: DurationString
  tags?: RunTagsBuilder<SchemaType<K, InputSchema>>
  idempotency?: RunIdempotencyBuilder<SchemaType<K, InputSchema>>
  unique?: RunUniqueBuilder<SchemaType<K, InputSchema>>
}

export type ScheduleOptions<
  Name extends string,
  Runnable extends RunnableDefinition,
> = {
  name: Name
  runnable: Runnable
  input: RunnableInput<Runnable>
  cron?: string
  every?: DurationString
  tags?: Readonly<Record<string, string>>
  enabled?: boolean
  immediately?: boolean
}

const nodeNamePattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function assertNodeName(name: string, nodes: readonly WorkflowNode[]) {
  if (!nodeNamePattern.test(name)) {
    throw new Error(`Invalid workflow node name: ${name}`)
  }
  if (name === 'input') {
    throw new Error('Workflow node name cannot be "input"')
  }
  if (nodes.some((node) => node.name === name)) {
    throw new Error(`Duplicate workflow node name: ${name}`)
  }
}

function assertMapConcurrency(options: { readonly concurrency?: number }) {
  if (options.concurrency === undefined) return
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Map node concurrency must be a positive integer')
  }
}

type ToCodec = (schema: any) => Schema

const schemaKeys = ['input', 'output', 'item'] as const

// Definitions always store codecs, whichever schema library declared them.
function withCodecs(options: object, toCodec: ToCodec): any {
  const result: Record<string, unknown> = { ...options }
  for (const key of schemaKeys) {
    if (result[key] !== undefined) result[key] = toCodec(result[key])
  }
  return result
}

function createBranchCaseHelpers(toCodec: ToCodec): BranchCaseHelpers {
  return Object.freeze({
    activity: (options: Parameters<BranchCaseHelpers['activity']>[0]) =>
      Object.freeze({ kind: 'activity', ...withCodecs(options, toCodec) }),
    task: (
      task: AnyTaskDefinition,
      options?: Parameters<BranchCaseHelpers['task']>[1],
    ) => Object.freeze({ kind: 'task', target: task, ...options }),
    workflow: (
      workflow: AnyWorkflowDefinition,
      options?: Parameters<BranchCaseHelpers['workflow']>[1],
    ) => Object.freeze({ kind: 'workflow', target: workflow, ...options }),
  }) as BranchCaseHelpers
}

class WorkflowDraftBuilder<Name extends string> {
  constructor(
    readonly options: WorkflowOptions<CodecKind, Name, any, any>,
    readonly toCodec: ToCodec,
    readonly nodes: readonly WorkflowNode[] = [],
  ) {}

  get name() {
    return this.options.name
  }

  get input() {
    return this.options.input
  }

  get output() {
    return this.options.output
  }

  activity(name: string, options: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({
        kind: 'activity',
        name,
        ...withCodecs(options, this.toCodec),
      }),
    )
  }

  task(name: string, task: AnyTaskDefinition, options?: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({ kind: 'task', name, task, ...options }),
    )
  }

  workflow(name: string, workflow: AnyWorkflowDefinition, options?: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({ kind: 'workflow', name, workflow, ...options }),
    )
  }

  branch(name: string, options: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({
        kind: 'branch',
        name,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
        output:
          options.output === undefined
            ? undefined
            : this.toCodec(options.output),
        cases: Object.freeze(
          options.cases(createBranchCaseHelpers(this.toCodec)),
        ),
      }),
    )
  }

  parallel(name: string, casesFactory: any, options?: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({
        kind: 'parallel',
        name,
        ...(options?.title === undefined ? {} : { title: options.title }),
        ...(options?.description === undefined
          ? {}
          : { description: options.description }),
        cases: Object.freeze(
          casesFactory(createBranchCaseHelpers(this.toCodec)),
        ),
      }),
    )
  }

  mapTask(name: string, task: AnyTaskDefinition, options: any) {
    assertNodeName(name, this.nodes)
    assertMapConcurrency(options)
    return this.withNode(
      Object.freeze({
        kind: 'mapTask',
        name,
        task,
        ...withCodecs(options, this.toCodec),
      }),
    )
  }

  mapWorkflow(name: string, workflow: AnyWorkflowDefinition, options: any) {
    assertNodeName(name, this.nodes)
    assertMapConcurrency(options)
    return this.withNode(
      Object.freeze({
        kind: 'mapWorkflow',
        name,
        workflow,
        ...withCodecs(options, this.toCodec),
      }),
    )
  }

  build() {
    return Object.freeze({
      kind: 'workflow',
      name: this.options.name,
      ...(this.options.title === undefined
        ? {}
        : { title: this.options.title }),
      ...(this.options.description === undefined
        ? {}
        : { description: this.options.description }),
      input: this.options.input,
      output: this.options.output,
      nodes: Object.freeze([...this.nodes]),
      retention: this.options.retention,
      timeout: this.options.timeout,
      tags: this.options.tags,
      idempotency: this.options.idempotency,
      unique: this.options.unique,
    })
  }

  private withNode(node: WorkflowNode) {
    return new WorkflowDraftBuilder(this.options, this.toCodec, [
      ...this.nodes,
      node,
    ])
  }
}

export type DefineWorkflow<K extends SchemaKind> = <
  Name extends string,
  InputSchema extends SchemaBound<K>,
  OutputSchema extends SchemaBound<K> | undefined = undefined,
>(
  options: WorkflowOptions<K, Name, InputSchema, OutputSchema>,
) => WorkflowBuilder<
  Name,
  SchemaType<K, InputSchema>,
  [],
  OutputSchema extends SchemaBound<K>
    ? SchemaType<K, OutputSchema>
    : NoDeclaredOutput,
  K
>

/** Definition builders for a schema library, given its conversion to codecs. */
export function createContract<K extends SchemaKind>(
  toCodec: (schema: SchemaBound<K>) => Schema,
): {
  readonly defineTask: DefineTask<K>
  readonly defineWorkflow: DefineWorkflow<K>
} {
  return {
    defineTask: (options) =>
      Object.freeze({ kind: 'task', ...withCodecs(options, toCodec) }) as any,
    defineWorkflow: (options) =>
      new WorkflowDraftBuilder(withCodecs(options, toCodec), toCodec) as any,
  }
}

export const { defineTask, defineWorkflow } = createContract<CodecKind>(
  (codec) => codec,
)

export function defineSchedule<
  Name extends string,
  Runnable extends RunnableDefinition,
>(
  options: ScheduleOptions<Name, Runnable>,
): ScheduleDefinition<Name, Runnable> {
  assertScheduleCadence(options)
  return Object.freeze({
    kind: 'schedule',
    ...options,
    enabled: options.enabled ?? true,
  }) as ScheduleDefinition<Name, Runnable>
}

function assertScheduleCadence(input: {
  readonly name: string
  readonly cron?: string
  readonly every?: string
}) {
  const cadenceCount =
    (input.cron === undefined ? 0 : 1) + (input.every === undefined ? 0 : 1)
  if (cadenceCount !== 1) {
    throw new Error(
      `Schedule [${input.name}] must define exactly one of cron/every`,
    )
  }

  if (input.every !== undefined) {
    const everyMs = parseDurationMs(input.every)
    if (everyMs === undefined || everyMs <= 0) {
      throw new Error(
        `Invalid schedule [${input.name}] every duration [${input.every}]`,
      )
    }
    return
  }

  try {
    CronExpressionParser.parse(input.cron!, { currentDate: new Date(0) })
  } catch (error) {
    throw new Error(`Invalid schedule [${input.name}] cron [${input.cron!}]`, {
      cause: error,
    })
  }
}
