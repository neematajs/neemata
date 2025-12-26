import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'
import type { AnyObjectLikeType, ObjectType } from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'
import { t } from '@nmtjs/type'

import { kJobStepKey } from '../constants.ts'

export type AnyJobStep = JobStep<
  AnyObjectLikeType,
  AnyObjectLikeType,
  any,
  any,
  any
>

export type JobStepHandler<
  Deps extends Dependencies,
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType,
  Return,
  Data = any,
> = (
  context: DependencyContext<Deps>,
  input: t.infer.decode.output<Input>,
  data: Data,
) => MaybePromise<null extends Return ? t.infer.encode.input<Output> : Return>

export interface JobStep<
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Output extends AnyObjectLikeType = AnyObjectLikeType,
  Deps extends Dependencies = Dependencies,
  Return = unknown,
  Data = any,
> extends Dependant {
  [kJobStepKey]: any
  input: Input
  output: Output
  dependencies: Deps
  handler: JobStepHandler<Deps, Input, Output, Return, Data>
}

export function createStep<
  Input extends AnyObjectLikeType,
  Output extends AnyObjectLikeType = ObjectType<{}>,
  Deps extends Dependencies = {},
  Return = unknown,
  Data = any,
>(step: {
  label?: string
  input: Input
  output?: Output
  dependencies?: Deps
  handler: JobStepHandler<Deps, Input, Output, Return, Data>
}): JobStep<Input, Output, Deps, Return, Data> {
  return Object.freeze({
    [kJobStepKey]: true,
    output: t.object({}) as unknown as Output,
    dependencies: {} as Deps,
    stack: tryCaptureStackTrace(),
    ...step,
  })
}

export function isJobStep(value: unknown): value is AnyJobStep {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as AnyJobStep)[kJobStepKey] === true
  )
}
