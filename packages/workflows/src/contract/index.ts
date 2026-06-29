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
  Schema,
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

declare const noDeclaredOutput: unique symbol
type NoDeclaredOutput = { readonly [noDeclaredOutput]: true }

type AvailableNodeName<Name extends string> = Name extends 'input'
  ? never
  : Name

type BranchCaseMap<Output> = Record<
  string,
  BranchCaseDefinition<any, any, Output>
>

type LeafCaseMap = Record<string, BranchCaseDefinition>

type BranchActivityCaseOptions<BranchOutput, InputSchema, OutputSchema> = {
  input: InputSchema
  output: OutputSchema
  retry?: RetryPolicy
  timeout?: DurationString
} & (OutputSchema extends Schema
  ? SchemaOutput<OutputSchema> extends BranchOutput
    ? unknown
    : never
  : never)

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
    SchemaOutput<InputSchema>,
    SchemaOutput<OutputSchema>
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
    SchemaOutput<InputSchema>,
    SchemaOutput<OutputSchema>
  >
  task<Task extends AnyTaskDefinition>(
    task: Task,
    options?: {
      retry?: RetryPolicy
      timeout?: DurationString
    },
  ): TaskOutput<Task> extends BranchOutput
    ? BranchCaseDefinition<'task', TaskInput<Task>, TaskOutput<Task>, Task>
    : never
  workflow<Workflow extends AnyWorkflowDefinition>(
    workflow: Workflow,
    options?: {
      cancellation?: CancellationPolicy
    },
  ): WorkflowOutput<Workflow> extends BranchOutput
    ? BranchCaseDefinition<
        'workflow',
        WorkflowInput<Workflow>,
        WorkflowOutput<Workflow>,
        Workflow
      >
    : never
}

export type WorkflowBuilder<
  Name extends string,
  Input,
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
        SchemaOutput<InputSchema>,
        SchemaOutput<OutputSchema>
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
    Cases extends BranchCaseMap<SchemaOutput<OutputSchema>>,
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
    [
      ...Nodes,
      WorkflowBranchNode<NodeName, Cases, any, SchemaOutput<OutputSchema>>,
    ],
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
      WorkflowBranchNode<NodeName, Cases, any, BranchCaseOutputUnion<Cases>>,
    ],
    DeclaredOutput
  >

  parallel<NodeName extends string, Cases extends LeafCaseMap>(
    name: AvailableNodeName<NodeName>,
    cases: (helpers: BranchCaseHelpers) => Cases,
  ): WorkflowBuilder<
    Name,
    Input,
    [
      ...Nodes,
      WorkflowParallelNode<NodeName, Cases, any, BranchCaseOutputs<Cases>>,
    ],
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
      WorkflowMapTaskNode<NodeName, Task, SchemaOutput<ItemSchema>, Mode>,
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
        SchemaOutput<ItemSchema>,
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
): TaskDefinition<Name, SchemaOutput<InputSchema>, SchemaOutput<OutputSchema>> {
  return Object.freeze({ kind: 'task', ...options }) as TaskDefinition<
    Name,
    SchemaOutput<InputSchema>,
    SchemaOutput<OutputSchema>
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
    return this.withNode(
      Object.freeze({ kind: 'mapTask', name, task, ...options }),
    )
  }

  mapWorkflow(name: string, workflow: AnyWorkflowDefinition, options: any) {
    assertNodeName(name, this.nodes)
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
  SchemaOutput<InputSchema>,
  [],
  OutputSchema extends Schema ? SchemaOutput<OutputSchema> : NoDeclaredOutput
> {
  return new WorkflowDraftBuilder(options) as any
}
