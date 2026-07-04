import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  BranchCaseOutputUnion,
  BranchCaseOutputs,
  CancellationPolicy,
  DurationString,
  MapRunMode,
  RetryPolicy,
  RunnableDefinition,
  RunnableInput,
  ScheduleDefinition,
  Schema,
  SchemaBoundary,
  SchemaInput,
  SchemaOutput,
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
import { CronExpressionParser } from 'cron-parser'
import { parseDurationMs } from '../runtime/duration.ts'

declare const noDeclaredOutput: unique symbol
type NoDeclaredOutput = { readonly [noDeclaredOutput]: true }

type AvailableNodeName<Name extends string> = Name extends 'input'
  ? never
  : Name

type BranchCaseMap = Record<string, BranchCaseDefinition>

type LeafCaseMap = Record<string, BranchCaseDefinition>

type BranchActivityCaseOptions<BranchOutput, InputSchema, OutputSchema> = {
  input: InputSchema
  output: OutputSchema
  retry?: RetryPolicy
  timeout?: DurationString
} & (OutputSchema extends Schema
  ? OutputMatches<
      SchemaOutput<OutputSchema>,
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

type SchemaSides<T extends Schema> = SchemaBoundary<
  SchemaInput<T>,
  SchemaOutput<T>
>

export type BranchCaseHelpers = {
  activity<
    InputSchema extends Schema,
    OutputSchema extends Schema = Schema,
  >(options: {
    input: InputSchema
    output: OutputSchema
    retry?: RetryPolicy
    timeout?: DurationString
  }): BranchCaseDefinition<
    'activity',
    SchemaSides<InputSchema>,
    SchemaSides<OutputSchema>
  >
  task<Task extends AnyTaskDefinition>(
    task: Task,
    options?: {
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): BranchCaseDefinition<'task', TaskInput<Task>, TaskOutput<Task>, Task>
  workflow<Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    options?: {
      cancellation?: CancellationPolicy
    },
  ): BranchCaseDefinition<
    'workflow',
    WorkflowInput<Workflow>,
    WorkflowOutput<Workflow>,
    Workflow
  >
}

export type ConvergedBranchCaseHelpers<BranchOutput> = {
  activity<InputSchema extends Schema, OutputSchema extends Schema = Schema>(
    options: BranchActivityCaseOptions<BranchOutput, InputSchema, OutputSchema>,
  ): BranchCaseDefinition<
    'activity',
    SchemaSides<InputSchema>,
    SchemaSides<OutputSchema>
  >
  task<Task extends AnyTaskDefinition>(
    task: Task &
      OutputMatches<
        TaskOutput<Task>,
        BranchOutput,
        'task case output does not satisfy branch output'
      >,
    options?: {
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
> = {
  readonly name: Name
  readonly input: Schema
  readonly output?: Schema
  readonly nodes: Nodes

  activity<
    NodeName extends string,
    InputSchema extends Schema,
    OutputSchema extends Schema,
  >(
    name: AvailableNodeName<NodeName>,
    options: {
      input: InputSchema
      output: OutputSchema
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
        SchemaSides<InputSchema>,
        SchemaSides<OutputSchema>
      >,
    ],
    DeclaredOutput
  >

  task<NodeName extends string, Task extends AnyTaskDefinition>(
    name: AvailableNodeName<NodeName>,
    task: Task,
    options?: {
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowTaskNode<NodeName, Task>],
    DeclaredOutput
  >

  workflow<NodeName extends string, Workflow extends AnyWorkflowDefinition>(
    name: AvailableNodeName<NodeName>,
    workflow: Workflow,
    options?: {
      cancellation?: CancellationPolicy
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowChildWorkflowNode<NodeName, Workflow>],
    DeclaredOutput
  >

  branch<
    NodeName extends string,
    OutputSchema extends Schema,
    Cases extends BranchCaseMap,
  >(
    name: AvailableNodeName<NodeName>,
    options: {
      output: OutputSchema
      cases: (
        helpers: ConvergedBranchCaseHelpers<SchemaOutput<OutputSchema>>,
      ) => Cases
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowBranchNode<NodeName, Cases, SchemaOutput<OutputSchema>>],
    DeclaredOutput
  >

  branch<NodeName extends string, Cases extends LeafCaseMap>(
    name: AvailableNodeName<NodeName>,
    options: {
      cases: (helpers: BranchCaseHelpers) => Cases
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowBranchNode<NodeName, Cases, BranchCaseOutputUnion<Cases>>,
    ],
    DeclaredOutput
  >

  parallel<NodeName extends string, Cases extends LeafCaseMap>(
    name: AvailableNodeName<NodeName>,
    cases: (helpers: BranchCaseHelpers) => Cases,
  ): WorkflowBuilder<
    Name,
    Input,
    [...Nodes, WorkflowParallelNode<NodeName, Cases, BranchCaseOutputs<Cases>>],
    DeclaredOutput
  >

  mapTask<
    NodeName extends string,
    Task extends AnyTaskDefinition,
    ItemSchema extends Schema,
    Mode extends MapRunMode,
  >(
    name: AvailableNodeName<NodeName>,
    task: Task,
    options: {
      item: ItemSchema
      mode: Mode
      concurrency?: number
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowMapTaskNode<NodeName, Task, SchemaSides<ItemSchema>, Mode>,
    ],
    DeclaredOutput
  >

  mapWorkflow<
    NodeName extends string,
    Workflow extends AnyWorkflowDefinition,
    ItemSchema extends Schema,
    Mode extends MapRunMode,
  >(
    name: AvailableNodeName<NodeName>,
    workflow: Workflow,
    options: {
      item: ItemSchema
      mode: Mode
      concurrency?: number
      cancellation?: CancellationPolicy
    },
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowMapWorkflowNode<
        NodeName,
        Workflow,
        SchemaSides<ItemSchema>,
        Mode
      >,
    ],
    DeclaredOutput
  >

  build(): WorkflowDefinition<
    Name,
    Input,
    DeclaredOutput extends NoDeclaredOutput ? unknown : DeclaredOutput,
    Nodes
  >
}

export type TaskOptions<
  Name extends string,
  InputSchema extends Schema,
  OutputSchema extends Schema,
> = {
  name: Name
  input: InputSchema
  output: OutputSchema
  retry?: RetryPolicy
  timeout?: DurationString
}

export function defineTask<
  Name extends string,
  InputSchema extends Schema,
  OutputSchema extends Schema,
>(
  options: TaskOptions<Name, InputSchema, OutputSchema>,
): TaskDefinition<Name, SchemaSides<InputSchema>, SchemaSides<OutputSchema>> {
  return Object.freeze({ kind: 'task', ...options }) as TaskDefinition<
    Name,
    SchemaSides<InputSchema>,
    SchemaSides<OutputSchema>
  >
}

export type WorkflowOptions<
  Name extends string,
  InputSchema extends Schema,
  OutputSchema extends Schema | undefined,
> = {
  name: Name
  input: InputSchema
  output?: OutputSchema
  retention?: DurationString
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

function createBranchCaseHelpers(): BranchCaseHelpers {
  return Object.freeze({
    activity: (options: any) => Object.freeze({ kind: 'activity', ...options }),
    task: (task: AnyTaskDefinition, options?: any) =>
      Object.freeze({ kind: 'task', target: task, ...options }),
    workflow: (workflow: AnyWorkflowDefinition, options?: any) =>
      Object.freeze({ kind: 'workflow', target: workflow, ...options }),
  }) as BranchCaseHelpers
}

class WorkflowDraftBuilder<Name extends string> {
  constructor(
    readonly options: WorkflowOptions<Name, any, any>,
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
    return this.withNode(Object.freeze({ kind: 'activity', name, ...options }))
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
        output: options.output,
        cases: Object.freeze(options.cases(createBranchCaseHelpers())),
      }),
    )
  }

  parallel(name: string, casesFactory: any) {
    assertNodeName(name, this.nodes)
    return this.withNode(
      Object.freeze({
        kind: 'parallel',
        name,
        cases: Object.freeze(casesFactory(createBranchCaseHelpers())),
      }),
    )
  }

  mapTask(name: string, task: AnyTaskDefinition, options: any) {
    assertNodeName(name, this.nodes)
    assertMapConcurrency(options)
    return this.withNode(
      Object.freeze({ kind: 'mapTask', name, task, ...options }),
    )
  }

  mapWorkflow(name: string, workflow: AnyWorkflowDefinition, options: any) {
    assertNodeName(name, this.nodes)
    assertMapConcurrency(options)
    return this.withNode(
      Object.freeze({ kind: 'mapWorkflow', name, workflow, ...options }),
    )
  }

  build() {
    return Object.freeze({
      kind: 'workflow',
      name: this.options.name,
      input: this.options.input,
      output: this.options.output,
      nodes: Object.freeze([...this.nodes]),
      retention: this.options.retention,
    }) as any
  }

  private withNode(node: WorkflowNode) {
    return new WorkflowDraftBuilder(this.options, [...this.nodes, node]) as any
  }
}

export function defineWorkflow<
  Name extends string,
  InputSchema extends Schema,
  OutputSchema extends Schema | undefined = undefined,
>(
  options: WorkflowOptions<Name, InputSchema, OutputSchema>,
): WorkflowBuilder<
  Name,
  SchemaSides<InputSchema>,
  [],
  OutputSchema extends Schema ? SchemaSides<OutputSchema> : NoDeclaredOutput
> {
  return new WorkflowDraftBuilder(options) as any
}

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
    throw new Error(
      `Invalid schedule [${input.name}] cron [${input.cron!}]`,
      { cause: error },
    )
  }
}
