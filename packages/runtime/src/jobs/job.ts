import type { TSError } from '@nmtjs/common'
import type { Dependencies } from '@nmtjs/core'
import type {
  AnyObjectLikeType,
  MergeObjectTypes,
  ObjectType,
} from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'
import { t } from '@nmtjs/type'

import type { JobWorkerQueue } from '../enums.ts'
import type { AnyJobStep, JobStep } from './step.ts'
import { kJobKey } from '../constants.ts'

type DefaultObjectType = ObjectType<{}>

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
  queue: JobWorkerQueue
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
  };
  [kJobKey] = true
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
            : TSError<`Previously accumulated job's result does not satisfies current step's input`>
          : t.infer.encode.input<StepOutput>
        : void
    >,
  ) {
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
