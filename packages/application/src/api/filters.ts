import type { ErrorClass } from '@nmtjs/common'
import type { Dependencies, Handler } from '@nmtjs/core'

import { kFilter } from './constants.ts'

export interface Filter<
  FilterError extends ErrorClass = ErrorClass,
  Deps extends Dependencies = Dependencies,
> extends Handler<Deps, [error: InstanceType<FilterError>], Error> {
  [kFilter]: true
  errorClass: FilterError
}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = Filter<
  Error,
  any
>

export function createFilter<
  FilterError extends ErrorClass,
  Deps extends Dependencies = {},
>(params: {
  errorClass: FilterError
  dependencies?: Deps
  handler: Filter<FilterError, Deps>['handler']
}): Filter<FilterError, Deps> {
  const { errorClass, dependencies = {} as Deps, handler } = params

  return Object.freeze({
    errorClass,
    dependencies,
    handler,
    [kFilter]: true,
  }) as Filter<FilterError, Deps>
}
