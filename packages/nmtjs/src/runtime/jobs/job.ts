import type { Async, TSError } from '@nmtjs/common'
import type {
  AnyInjectable,
  Dependencies,
  DependencyContext,
} from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import type { AnyObjectLikeType } from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { JobWorkerPool } from '../enums.ts'
import { kJobKey } from '../constants.ts'

export type AnyJobStep = JobStep<any, any, any>

export type JobStepHandler<Result, Deps extends Dependencies, Return> = (
  context: DependencyContext<Deps>,
  result: Readonly<Result>,
  signal: AbortSignal,
) => Async<Return>

export type JobStepCondition<Result, Deps extends Dependencies> = (
  context: DependencyContext<Deps>,
  result: Readonly<Result>,
) => Async<boolean>

export type JobReturn<
  Result,
  Deps extends Dependencies,
  Output extends AnyObjectLikeType,
  Return = t.infer.encode.input<Output>,
> = (
  context: DependencyContext<Deps>,
  result: Readonly<Result>,
) => Async<Return>

export type JobContext<
  Ctx,
  Deps extends Dependencies,
  Input extends AnyObjectLikeType,
> = (
  ctx: DependencyContext<Deps>,
  input: t.infer.decode.output<Input>,
) => Async<Ctx>

export interface JobStep<
  Result = unknown,
  Deps extends Dependencies = Dependencies,
  Return = unknown,
> {
  handler: JobStepHandler<Result, Deps, Return>
  condition?: JobStepCondition<Result, Deps>
  label?: string
}

export type AnyJob = Job<
  string,
  any,
  any,
  [AnyJobStep, ...AnyJobStep[]],
  any,
  any,
  any,
  true
>

export type JobBackoffOptions = {
  type: 'fixed' | 'exponential'
  delay: number
  jitter?: number
}

export interface JobOptions<
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Ctx,
  Deps extends Dependencies,
> {
  pool: JobWorkerPool
  input: Input
  output: Output
  dependencies?: Deps
  context?: JobContext<Ctx, Deps, Input>
  /**
   * Maximum number of concurrent executions of this job.
   * If not specified, concurrency is calculated based on pool capacity
   * divided by number of jobs in the pool.
   */
  concurrency?: number
  attempts?: number
  backoff?: JobBackoffOptions
  oneoff?: boolean
}

export class Job<
  Name extends string = string,
  Ctx = undefined,
  Deps extends Dependencies = {},
  Steps extends AnyJobStep[] = [],
  Result extends Record<string, unknown> = {},
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Output extends AnyObjectLikeType = AnyObjectLikeType,
  HasReturn extends boolean = false,
  StepDeps extends Dependencies = Deps & { $context: AnyInjectable<Ctx> },
> {
  _!: {
    result: Result
    input: t.infer.decode.output<Input>
    output: t.infer.encode.input<Output>
  };
  [kJobKey] = true
  steps: Steps = [] as unknown as Steps
  input: Input
  output: Output = undefined as unknown as Output
  dependencies: Deps
  context: JobContext<Ctx, Deps, Input>
  returnHandler?: JobReturn<Result, Deps, Output>

  constructor(
    public name: Name,
    public options: JobOptions<Input, Output, Ctx, Deps>,
    public stack?: string,
  ) {
    this.dependencies = (options.dependencies || {}) as Deps
    this.input = options.input
    this.output = options.output
    this.context = options.context as typeof this.context
  }

  add<
    StepOutput,
    StepCondition extends JobStepCondition<Result, StepDeps> | undefined,
  >(options: {
    handler: HasReturn extends true
      ? TSError<'Cannot add more steps after return() has been called.'>
      : JobStepHandler<Result, StepDeps, StepOutput>
    condition?: StepCondition
    label?: string
  }): Job<
    Name,
    Ctx,
    StepDeps,
    [...Steps, JobStep<Result, StepDeps, StepOutput>],
    Result &
      ((StepCondition extends undefined ? false : true) extends true
        ? Partial<StepOutput>
        : StepOutput),
    Input,
    Output,
    false
  > {
    const { handler, condition, label } = options

    if (this.returnHandler || typeof handler !== 'function')
      throw new Error('Cannot add more steps after return() has been called.')
    this.steps.push({ handler, label, condition })
    return this as any
  }

  return(
    ...[handler]: HasReturn extends true
      ? [TSError<'return() has already been called.'>]
      : Result extends t.infer.encode.input<Output>
        ? [handler?: JobReturn<Result, Deps, Output>]
        : [handler: JobReturn<Result, Deps, Output>]
  ) {
    handler ??= (result) => result
    if (this.returnHandler || typeof handler !== 'function')
      throw new Error('return() has already been called.')
    this.returnHandler = handler
    return this as unknown as Job<
      Name,
      Ctx,
      Deps,
      Steps,
      Result,
      Input,
      Output,
      true
    >
  }
}

export function createJob<
  Name extends string,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Ctx,
  Deps extends Dependencies = {},
>(name: Name, options: JobOptions<Input, Output, Ctx, Deps>) {
  const stack = tryCaptureStackTrace()
  return new Job(name, options, stack)
}
