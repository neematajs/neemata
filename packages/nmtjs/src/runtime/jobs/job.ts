import type { MaybePromise, TSError } from '@nmtjs/common'
import type { Dependencies, DependencyContext } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import type { AnyObjectLikeType, ObjectType } from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { JobWorkerPool } from '../enums.ts'
import type { AnyJobStep, JobStep } from './step.ts'
import { kJobKey } from '../constants.ts'
import { isJobStep } from './step.ts'

type DefaultObjectType = ObjectType<{}>

export type AnyJobOptions = JobOptions<
  string,
  AnyObjectLikeType,
  AnyObjectLikeType,
  any,
  any
>
export type AnyJob = Job<
  string,
  any,
  any,
  AnyObjectLikeType,
  AnyObjectLikeType,
  AnyJobStep[],
  Record<string, unknown>,
  true
>

export type JobBackoffOptions = {
  type: 'fixed' | 'exponential'
  delay: number
  jitter?: number
}

export type JobCondition<
  Deps extends Dependencies = {},
  Result extends Record<string, unknown> = {},
  Data = any,
  Input extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
}) => MaybePromise<boolean>

export type JobReturnHandler<
  Deps extends Dependencies,
  Result extends Record<string, unknown>,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Data,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
}) => MaybePromise<t.infer.encode.input<Output>>

export type JobDataHandler<
  Deps extends Dependencies,
  Input extends AnyObjectLikeType,
  Data,
> = (
  ctx: DependencyContext<Deps>,
  input: t.infer.decode.output<Input>,
) => MaybePromise<Data>

export type JobAfterEachHandler<
  Deps extends Dependencies,
  Result extends Record<string, unknown>,
  Input extends AnyObjectLikeType,
  Data,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  step: AnyJobStep
  stepIndex: number
}) => MaybePromise<void>

export type JobBeforeEachHandler<
  Deps extends Dependencies,
  Result extends Record<string, unknown>,
  Input extends AnyObjectLikeType,
  Data,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  step: AnyJobStep
  stepIndex: number
}) => MaybePromise<void>

export type JobOnErrorHandler<
  Deps extends Dependencies,
  Result extends Record<string, unknown>,
  Input extends AnyObjectLikeType,
  Data,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  step: AnyJobStep
  stepIndex: number
  error: unknown
}) => MaybePromise<
  | boolean
  // biome-ignore lint/suspicious/noConfusingVoidType: its ok
  | void
>

export interface JobOptions<
  Name extends string = string,
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Output extends AnyObjectLikeType = AnyObjectLikeType,
  Deps extends Dependencies = {},
  Data = any,
> {
  name: Name
  pool: JobWorkerPool
  input: Input
  output: Output
  concurrency?: number
  timeout?: number
  dependencies?: Deps
  data?: JobDataHandler<Deps, Input, Data>
  attempts?: number
  backoff?: JobBackoffOptions
  oneoff?: boolean
}

export class Job<
  out Name extends string = string,
  in out Deps extends Dependencies = {},
  in out Data = any,
  in out Input extends AnyObjectLikeType = DefaultObjectType,
  in out Output extends AnyObjectLikeType = DefaultObjectType,
  in out Steps extends AnyJobStep[] = [],
  in out Result extends Record<string, unknown> &
    t.infer.decode.output<Input> = t.infer.decode.output<Input>,
  out Return extends boolean = false,
> {
  _!: {
    data: Data
    result: Result
    input: t.infer.decode.output<Input>
    output: t.infer.decode.output<Output>
  };
  [kJobKey] = true
  steps: Steps = [] as unknown as Steps
  conditions: Map<
    number,
    JobCondition<Deps, Result, this['_']['data'], Input>
  > = new Map()
  returnHandler?: JobReturnHandler<Deps, Result, Input, Output, Data>
  afterEachHandler?: JobAfterEachHandler<Deps, Result, Input, Data>
  beforeEachHandler?: JobBeforeEachHandler<Deps, Result, Input, Data>
  onErrorHandler?: JobOnErrorHandler<Deps, Result, Input, Data>

  constructor(
    public options: JobOptions<Name, Input, Output, Deps, Data>,
    public stack?: string,
  ) {}

  get name(): Name {
    return this.options.name
  }

  get dependencies(): Deps {
    return this.options.dependencies ?? ({} as Deps)
  }

  get input(): Input {
    return this.options.input as Input
  }

  get output(): Output {
    return this.options.output as Output
  }

  step<
    StepInput extends AnyObjectLikeType,
    StepOutput extends AnyObjectLikeType,
    StepDeps extends Dependencies,
    Condition extends
      | JobCondition<Deps, Result, this['_']['data'], Input>
      | undefined,
  >(
    ...[step, condition]: Return extends false
      ? [
          step: JobStep<
            StepInput,
            StepOutput,
            StepDeps,
            Result extends t.infer.decode.output<StepInput>
              ? t.infer.decode.output<StepOutput>
              : TSError<
                  'Accumulated job result does not satisfy current step input:',
                  Result
                >,
            this['_']['data']
          >,
          condition?: Condition,
        ]
      : [TSError<'Job has already has return statement'>]
  ) {
    if (!isJobStep(step)) throw new Error('Invalid job step object')

    const length = this.steps.push(step)
    if (condition) this.conditions.set(length - 1, condition)

    return this as unknown as Job<
      Name,
      Deps,
      Data,
      Input,
      Output,
      [...Steps, JobStep<StepInput, StepOutput, any, any, any>],
      Result &
        (undefined extends Condition
          ? t.infer.decode.output<
              StepOutput extends undefined ? DefaultObjectType : StepOutput
            >
          : Partial<
              t.infer.decode.output<
                StepOutput extends undefined ? DefaultObjectType : StepOutput
              >
            >)
    >
  }

  return(
    ...[handler]: Return extends false
      ? Result extends t.infer.encode.input<Output>
        ? [JobReturnHandler<Deps, Result, Input, Output, Data>?]
        : [JobReturnHandler<Deps, Result, Input, Output, Data>]
      : [TSError<'Job already has a return statement'>]
  ) {
    if (typeof handler === 'function') {
      this.returnHandler = handler
    } else {
      this.returnHandler = (result) => result as any
    }
    return this as unknown as Job<
      Name,
      Deps,
      Data,
      Input,
      Output,
      Steps,
      Result,
      true
    >
  }

  afterEach(
    handler: Return extends true
      ? JobAfterEachHandler<Deps, Result, Input, Data>
      : TSError<'Job must have a return statement to use afterEach'>,
  ) {
    this.afterEachHandler = handler as any
    return this
  }

  beforeEach(
    handler: Return extends true
      ? JobBeforeEachHandler<Deps, Result, Input, Data>
      : TSError<'Job must have a return statement to use beforeEach'>,
  ) {
    this.beforeEachHandler = handler as any
    return this
  }

  onError(
    handler: Return extends true
      ? JobOnErrorHandler<Deps, Result, Input, Data>
      : TSError<'Job must have a return statement to use onError'>,
  ) {
    this.onErrorHandler = handler as any
    return this
  }
}

export function createJob<
  Name extends string,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Deps extends Dependencies = {},
  Data = any,
>(options: JobOptions<Name, Input, Output, Deps, Data>) {
  const stack = tryCaptureStackTrace()
  return new Job<Name, Deps, Data, Input, Output>(
    { dependencies: {} as Deps, ...options },
    stack,
  )
}
