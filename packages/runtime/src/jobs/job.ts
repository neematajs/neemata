import type { Async, TSError } from '@nmtjs/common'
import type { Dependencies, DependencyContext } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import type { AnyObjectLikeType } from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { JobWorkerQueue } from '../enums.ts'
import { kJobKey } from '../constants.ts'

export type AnyJobStep = JobStep<any, any, any>

export type JobStepHandler<Ctx, Deps extends Dependencies, Return> = (
  context: DependencyContext<Deps>,
  jobContext: Ctx,
  signal: AbortSignal,
) => Async<Return>

export interface JobStep<
  Ctx = unknown,
  Deps extends Dependencies = Dependencies,
  Return = unknown,
> {
  handler: JobStepHandler<Ctx, Deps, Return>
  label?: string
}

export type AnyJob = Job<
  string,
  any,
  any,
  [AnyJobStep, ...AnyJobStep[]],
  Record<string, unknown>,
  AnyObjectLikeType,
  AnyObjectLikeType,
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
  Ctx = undefined,
  Deps extends Dependencies = {},
> {
  queue: JobWorkerQueue
  input: Input
  output: Output
  dependencies?: Deps
  context?: (
    ctx: DependencyContext<Deps>,
    input: t.infer.decode.output<Input>,
  ) => Async<Ctx>
  attempts?: number
  backoff?: JobBackoffOptions
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
> {
  _!: {
    output: Result
    input: Input extends AnyObjectLikeType ? t.infer.encode.input<Input> : never
  };
  [kJobKey] = true
  steps: Steps = [] as unknown as Steps
  input: Input
  output: Output = undefined as unknown as Output
  dependencies: Deps
  context: (
    ctx: DependencyContext<Deps>,
    input: t.infer.decode.output<Input>,
  ) => Async<Ctx>
  returnHandler?: (result: Result) => Async<t.infer.encode.input<Output>>

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

  add<StepOutput>(
    handler: HasReturn extends true
      ? TSError<'Cannot add more steps after return() has been called.'>
      : JobStepHandler<Ctx, Deps, StepOutput>,
    label?: string,
  ): Job<
    Name,
    Ctx,
    Deps,
    [...Steps, JobStep<Ctx, Deps, StepOutput>],
    Result & StepOutput,
    Input,
    Output,
    false
  > {
    if (this.returnHandler || typeof handler !== 'function')
      throw new Error('Cannot add more steps after return() has been called.')
    this.steps.push({ handler, label })
    return this as any
  }

  return(
    handler: HasReturn extends true
      ? TSError<'return() has already been called.'>
      : (result: Result) => Async<t.infer.encode.input<Output>>,
  ) {
    if (this.returnHandler || typeof handler !== 'function')
      throw new Error('return() has already been called.')
    this.returnHandler = handler
  }
}

export function createJob<
  Name extends string,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Ctx,
  Deps extends Dependencies,
>(name: Name, options: JobOptions<Input, Output, Ctx, Deps>) {
  const stack = tryCaptureStackTrace()
  return new Job(name, options, stack)
}
