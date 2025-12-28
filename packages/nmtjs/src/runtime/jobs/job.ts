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

type DefaultResultType = Record<string, any>

export type AnyJobOptions = JobOptions<string, any, any, any, any, any>

export interface AnyJob {
  _: { data: any; result: any; input: any; output: any; progress: any }
  [kJobKey]: true
  options: AnyJobOptions
  steps: readonly AnyJobStep[]
  conditions: Map<number, JobCondition<any, any, any, any>>
  name: string
  dependencies: Dependencies
  input: AnyObjectLikeType
  output: AnyObjectLikeType
  progress: AnyObjectLikeType
  afterEachHandler?: JobAfterEachHandler<any, any, any, any, any>
  beforeEachHandler?: JobBeforeEachHandler<any, any, any, any, any>
  onErrorHandler?: JobOnErrorHandler<any, any, any, any, any>
  returnHandler?: JobReturnHandler<any, any, any, any, any, any>
}

export type JobBackoffOptions = {
  type: 'fixed' | 'exponential'
  delay: number
  jitter?: number
}

export type JobCondition<
  Deps extends Dependencies = {},
  Result extends DefaultResultType = {},
  Data = any,
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  progress: t.infer.decode.output<Progress>
}) => MaybePromise<boolean>

export type JobReturnHandler<
  Deps extends Dependencies,
  Result extends DefaultResultType,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Data,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  progress: t.infer.decode.output<Progress>
}) => MaybePromise<t.infer.encode.input<Output>>

export type JobDataHandler<
  Deps extends Dependencies,
  Input extends AnyObjectLikeType,
  Data,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (
  ctx: DependencyContext<Deps>,
  input: t.infer.decode.output<Input>,
  progress: t.infer.decode.output<Progress>,
) => MaybePromise<Data>

export type JobAfterEachHandler<
  Deps extends Dependencies,
  Result extends DefaultResultType,
  Input extends AnyObjectLikeType,
  Data,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  progress: t.infer.decode.output<Progress>
  step: AnyJobStep
  stepIndex: number
}) => MaybePromise<void>

export type JobBeforeEachHandler<
  Deps extends Dependencies,
  Result extends DefaultResultType,
  Input extends AnyObjectLikeType,
  Data,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  progress: t.infer.decode.output<Progress>
  step: AnyJobStep
  stepIndex: number
}) => MaybePromise<void>

export type JobOnErrorHandler<
  Deps extends Dependencies,
  Result extends DefaultResultType,
  Input extends AnyObjectLikeType,
  Data,
  Progress extends AnyObjectLikeType = AnyObjectLikeType,
> = (params: {
  context: DependencyContext<Deps>
  data: Data
  input: t.infer.decode.output<Input>
  result: Result
  progress: t.infer.decode.output<Progress>
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
  Progress extends AnyObjectLikeType = DefaultObjectType,
  Deps extends Dependencies = {},
  Data = any,
> {
  name: Name
  pool: JobWorkerPool
  input: Input
  output: Output
  progress?: Progress
  concurrency?: number
  timeout?: number
  dependencies?: Deps
  data?: JobDataHandler<Deps, Input, Data, Progress>
  attempts?: number
  backoff?: JobBackoffOptions
  oneoff?: boolean
}

export class Job<
  in out Name extends string = string,
  in out Deps extends Dependencies = {},
  in out Data = any,
  in out Input extends AnyObjectLikeType = DefaultObjectType,
  in out Output extends AnyObjectLikeType = DefaultObjectType,
  in out Progress extends AnyObjectLikeType = DefaultObjectType,
  out Steps extends [...AnyJobStep[]] = [],
  in out Result extends DefaultResultType = {},
  out Return extends boolean = false,
> implements AnyJob
{
  _!: {
    data: Data
    result: Result & t.infer.decode.output<Input>
    input: t.infer.decode.output<Input>
    output: t.infer.decode.output<Output>
    progress: t.infer.decode.output<Progress>
  };
  [kJobKey] = true as const
  steps: Steps = [] as unknown as Steps
  conditions: Map<number, JobCondition<any, any, any, any, any>> = new Map()
  returnHandler?: JobReturnHandler<
    Deps,
    this['_']['result'],
    Input,
    Output,
    Data,
    Progress
  >
  afterEachHandler?: JobAfterEachHandler<
    Deps,
    this['_']['result'],
    Input,
    Data,
    Progress
  >
  beforeEachHandler?: JobBeforeEachHandler<
    Deps,
    this['_']['result'],
    Input,
    Data,
    Progress
  >
  onErrorHandler?: JobOnErrorHandler<
    Deps,
    this['_']['result'],
    Input,
    Data,
    Progress
  >

  constructor(
    public options: JobOptions<Name, Input, Output, Progress, Deps, Data>,
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

  get progress(): Progress {
    return this.options.progress as Progress
  }

  step<
    StepInput extends AnyObjectLikeType,
    StepOutput extends AnyObjectLikeType,
    StepDeps extends Dependencies,
    StepResult,
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
            this['_']['result'] extends t.infer.decode.output<StepInput>
              ? t.infer.decode.output<StepOutput>
              : TSError<
                  'Accumulated job result does not satisfy current step input:',
                  this['_']['result']
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
      Progress,
      [...Steps, JobStep<StepInput, StepOutput, StepDeps, StepResult, any>],
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
        ? [
            JobReturnHandler<
              Deps,
              this['_']['result'],
              Input,
              Output,
              Data,
              Progress
            >?,
          ]
        : [
            JobReturnHandler<
              Deps,
              this['_']['result'],
              Input,
              Output,
              Data,
              Progress
            >,
          ]
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
      Progress,
      Steps,
      Result,
      true
    >
  }

  afterEach(
    handler: Return extends true
      ? JobAfterEachHandler<Deps, this['_']['result'], Input, Data, Progress>
      : TSError<'Job must have a return statement to use afterEach'>,
  ) {
    this.afterEachHandler = handler as any
    return this
  }

  beforeEach(
    handler: Return extends true
      ? JobBeforeEachHandler<Deps, this['_']['result'], Input, Data, Progress>
      : TSError<'Job must have a return statement to use beforeEach'>,
  ) {
    this.beforeEachHandler = handler as any
    return this
  }

  onError(
    handler: Return extends true
      ? JobOnErrorHandler<Deps, this['_']['result'], Input, Data, Progress>
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
  Progress extends AnyObjectLikeType = DefaultObjectType,
>(options: JobOptions<Name, Input, Output, Progress, Deps, Data>) {
  const stack = tryCaptureStackTrace()
  return new Job<Name, Deps, Data, Input, Output, Progress>(
    { dependencies: {} as Deps, ...options },
    stack,
  )
}
