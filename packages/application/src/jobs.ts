import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'
import type {
  AnyObjectLikeType,
  MergeObjectTypes,
  ObjectType,
} from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'
import { t } from '@nmtjs/type'

import type { ApplicationWorkerType } from './enums.ts'
import { kJobKey } from './constants.ts'

export type AnyJobStep = JobStep<any, any, any, any>

export type JobStepHandler<
  Deps extends Dependencies,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Return,
> = (
  context: DependencyContext<Deps>,
  input: t.infer.decode.output<Input>,
  signal: AbortSignal,
) => Promise<null extends Return ? t.infer.encode.input<Output> : Return>

export interface JobStep<
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Output extends AnyObjectLikeType = AnyObjectLikeType,
  Deps extends Dependencies = Dependencies,
  Return = unknown,
> extends Dependant {
  input: Input
  output: Output
  dependencies: Deps
  handler: JobStepHandler<Deps, Output, Input, Return>
}

export function createStep<
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType = ObjectType<{}>,
  Deps extends Dependencies = {},
  Return = unknown,
>(step: {
  input: Input
  label?: string
  output?: Output
  dependencies?: Deps
  handler: JobStepHandler<Deps, Input, Output, Return>
}): JobStep<Input, Output, Deps, Return> {
  return Object.freeze({
    [kJobKey]: true,
    output: t.object({}) as unknown as Output,
    dependencies: {} as Deps,
    stack: tryCaptureStackTrace(),
    ...step,
  })
}

type DefaultObjectType = ObjectType<{}>

const JobTypeErrorSymbol: unique symbol = Symbol('JobTypeError')

type JobTypeError<T extends string = string> = `Error: ${T}` & {
  [JobTypeErrorSymbol]: true
}

export type ExtractStepsOutput<Steps extends AnyJobStep[]> = Steps extends [
  infer First extends AnyJobStep,
  ...infer Rest extends AnyJobStep[],
]
  ? First extends JobStep<any, infer OutputType extends AnyObjectLikeType, any>
    ? MergeObjectTypes<OutputType, ExtractStepsOutput<Rest>>
    : DefaultObjectType
  : DefaultObjectType

export type AnyJob = Job<
  string,
  AnyJobStep[],
  Record<string, unknown>,
  AnyObjectLikeType | undefined,
  AnyObjectLikeType | undefined
>

export interface JobOptions {
  type: ApplicationWorkerType.Compute | ApplicationWorkerType.Io
  attemts?: number
  backoff?: { type: 'fixed' | 'exponential'; delay: number; jitter?: number }
}

export class Job<
  Name extends string = string,
  Steps extends AnyJobStep[] = [],
  Result extends Record<string, unknown> = {},
  Input extends AnyObjectLikeType | undefined = Steps extends [
    infer First extends AnyJobStep,
    ...any,
  ]
    ? First['input']
    : undefined,
  Output extends AnyObjectLikeType | undefined = Steps extends []
    ? undefined
    : ExtractStepsOutput<Steps>,
> {
  _!: {
    output: Result
    input: Input extends AnyObjectLikeType ? t.infer.encode.input<Input> : never
  }

  steps: Steps = [] as unknown as Steps
  input: Input = undefined as unknown as Input
  output: Output = undefined as unknown as Output

  constructor(
    public name: Name,
    public options: JobOptions,
    public stack?: string,
  ) {}

  add<
    StepInput extends AnyObjectLikeType,
    StepOutput extends AnyObjectLikeType,
    Deps extends Dependencies = {},
  >(
    step: JobStep<
      StepInput,
      StepOutput,
      Deps,
      StepInput extends AnyObjectLikeType
        ? Output extends AnyObjectLikeType
          ? Result extends t.infer.decode.output<StepInput>
            ? t.infer.encode.input<StepOutput>
            : JobTypeError<`Previously accumulated job's result does not satisfies current step's input`>
          : t.infer.encode.input<StepOutput>
        : void
    >,
  ) {
    // const _step = { output: t.object({}), dependencies: {}, ...(step as any) }
    this.steps.push(step)
    this.addOutput(step.output as AnyObjectLikeType)
    if (this.input === undefined) {
      this.input = step.input as unknown as Input
    }

    return this as unknown as Job<
      Name,
      [
        ...Steps,
        JobStep<
          StepInput extends undefined ? DefaultObjectType : StepInput,
          StepOutput extends undefined ? DefaultObjectType : StepOutput,
          Deps
        >,
      ],
      Result &
        t.infer.decode.output<
          StepOutput extends undefined ? DefaultObjectType : StepOutput
        >
      // Input extends null ? StepInput : Input
    >
  }

  protected addOutput(output: AnyObjectLikeType) {
    this.output = (
      this.output ? t.merge(this.output, output) : output
    ) as Output
  }
}

export function createJob<Name extends string>(
  name: Name,
  options: JobOptions,
) {
  const stack = tryCaptureStackTrace()
  return new Job(name, options, stack)
}
