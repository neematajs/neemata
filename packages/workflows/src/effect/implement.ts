import type * as Effect from 'effect/Effect'

import type {
  ActivityImplementationOptions,
  AttemptLifecycle,
  ItemOfMapNode,
  NodeOutput,
  RunnableCaseDescriptor,
  TaskHandler as StoredTaskHandler,
  TaskImplementation,
  WorkflowImplementation,
  WorkflowImplementationOptions,
  WorkflowInputMapperArguments,
  WorkflowMapInputMapper,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
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
import type { HandlerRuntime } from './handler.ts'
import {
  createImplementationChain,
  implementTask as implementStoredTask,
} from '../implement/index.ts'

declare const unsupportedEnv: unique symbol

/**
 * Stands in for the env of a core handler that an Effect worker cannot supply:
 * such a worker passes handlers a HandlerRuntime and nothing else. No Layer or
 * Context provides it, so the worker fails to compile rather than at runtime.
 */
type UnsupportedEnv<E> = { readonly [unsupportedEnv]: E }

type Provided<E> = 0 extends 1 & E
  ? any
  : // Env-less core handlers accept whatever runtime the worker passes.
    [HandlerRuntime] extends [E]
    ? never
    : E extends HandlerRuntime<infer R>
      ? // The runtime is the whole env an Effect worker passes: a subtype
        // asking for more than it would find those members undefined.
        [HandlerRuntime<R>] extends [E]
        ? R
        : UnsupportedEnv<E>
      : UnsupportedEnv<E>

/**
 * Services an implementation's handlers require from the worker. Lists in the
 * erased form carry no requirement to check.
 */
export type Requirements<T> =
  T extends TaskImplementation<AnyTaskDefinition, infer E>
    ? Provided<E>
    : T extends WorkflowImplementation<AnyWorkflowDefinition, infer E>
      ? Provided<E>
      : never

export type TaskHandler<R, Input, Output> = (
  input: Input,
  lifecycle: AttemptLifecycle,
) => Effect.Effect<Output, unknown, R>

export type ActivityHandler<R, Input, Output> = TaskHandler<R, Input, Output>

export type FinishHandler<R, Outputs, Input, Output> = (
  outputs: Outputs,
  workflowInput: Input,
) => Effect.Effect<Output, unknown, R>

// Stored handlers receive the worker's runtime as their env and run through it.
function storedHandler<R, Input, Output>(
  handler: TaskHandler<R, Input, Output>,
): StoredTaskHandler<HandlerRuntime<R>, Input, Output> {
  return (input, lifecycle, runtime) =>
    runtime.run(() => handler(input, lifecycle), lifecycle.signal)
}

export function implementTask<Task extends AnyTaskDefinition, R = never>(
  task: Task,
  options: {
    /** The execution pool whose workers run this task. */
    pool: string
    handler: TaskHandler<R, TaskInput<Task>, TaskOutput<Task>>
  },
): TaskImplementation<Task, HandlerRuntime<R>> {
  return implementStoredTask(task, {
    pool: options.pool,
    handler: storedHandler(options.handler),
  })
}

// A stored ActivityImplementation is not accepted here: its Promise handler
// would compete with the Effect one when inferring Output.
type ActivityImplementationValue<Input, Output, R = never> =
  | ActivityHandler<R, Input, Output>
  | { readonly handler: ActivityHandler<R, Input, Output> }

type ActivityCaseDescriptor<Input, Output, R = never> = {
  readonly kind: 'activityCase'
  readonly value: ActivityImplementationValue<Input, Output, R>
  readonly options?: ActivityImplementationOptions<any, any, Input>
}

type AnyActivityImplementationValue<Input, Output> =
  ActivityImplementationValue<Input, Output, any>

type AnyActivityCaseDescriptor<Input, Output> = ActivityCaseDescriptor<
  Input,
  Output,
  any
>

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
  readonly activity: <NodeInput, Output, R = never>(
    value: ActivityImplementationValue<NodeInput, Output, R>,
    ...options: WorkflowInputMapperArguments<Outputs, Input, NodeInput>
  ) => ActivityCaseDescriptor<NodeInput, Output, R>
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

// The chain below mirrors the one in ../implement/index.ts with Effect handlers.
// TypeScript cannot infer a handler's services through a type-level function,
// so the two are written out and must change together.
export type WorkflowImplementationChain<
  Workflow extends AnyWorkflowDefinition,
  WorkflowR,
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
        readonly [Key in Name]: <R = never>(
          value: ActivityImplementationValue<Input, Output, R>,
          ...options: WorkflowInputMapperArguments<Outputs, WorkflowArgs, Input>
        ) => WorkflowImplementationChain<
          Workflow,
          WorkflowR | R,
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
            WorkflowR,
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
              WorkflowR,
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
                WorkflowR | CaseRequirements<Values>,
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
                  WorkflowR | CaseRequirements<Values>,
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
                    WorkflowR,
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
                      WorkflowR,
                      Rest,
                      Outputs & NodeOutput<Node>,
                      WorkflowArgs,
                      Result
                    >
                  }
                : WorkflowImplementationChain<
                    Workflow,
                    WorkflowR,
                    Rest,
                    Outputs,
                    WorkflowArgs,
                    Result
                  >
  : {
      readonly finish: <R = never>(
        finish: FinishHandler<R, Outputs, WorkflowArgs, Result>,
      ) => WorkflowImplementation<Workflow, HandlerRuntime<WorkflowR | R>>
    }

export type WorkflowImplementer<
  Workflow extends AnyWorkflowDefinition = AnyWorkflowDefinition,
  WorkflowR = never,
> = WorkflowImplementationChain<
  Workflow,
  WorkflowR,
  WorkflowNodes<Workflow>,
  {},
  WorkflowInput<Workflow>,
  WorkflowOutput<Workflow>
>

export function implementWorkflow<
  Workflow extends AnyWorkflowDefinition,
  WorkflowR = never,
>(
  workflow: Workflow,
  options: WorkflowImplementationOptions,
): WorkflowImplementer<Workflow, WorkflowR> {
  return createImplementationChain(workflow, options, {
    handler: storedHandler,
    finish:
      (finish: FinishHandler<unknown, unknown, unknown, unknown>) =>
      (outputs, workflowInput, lifecycle, runtime: HandlerRuntime<unknown>) =>
        runtime.run(() => finish(outputs, workflowInput), lifecycle.signal),
  }) as WorkflowImplementer<Workflow, WorkflowR>
}
