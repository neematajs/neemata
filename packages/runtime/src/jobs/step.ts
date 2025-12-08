import type { Async } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'
import type { AnyObjectLikeType, ObjectType } from '@nmtjs/type/object'
import { tryCaptureStackTrace } from '@nmtjs/common'
import { t } from '@nmtjs/type'

import { kJobStepKey } from '../constants.ts'

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
) => Async<null extends Return ? t.infer.encode.input<Output> : Return>

export interface JobStep<
  Input extends AnyObjectLikeType = AnyObjectLikeType,
  Output extends AnyObjectLikeType = AnyObjectLikeType,
  Deps extends Dependencies = Dependencies,
  Return = unknown,
> extends Dependant {
  [kJobStepKey]: any
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
    [kJobStepKey]: true,
    output: t.object({}) as unknown as Output,
    dependencies: {} as Deps,
    stack: tryCaptureStackTrace(),
    ...step,
  })
}
