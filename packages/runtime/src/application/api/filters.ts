import type { Async, ErrorClass } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import { kFilter } from './constants.ts'

export interface Filter<
  FilterError extends ErrorClass = ErrorClass,
  Deps extends Dependencies = Dependencies,
> extends Dependant<Deps> {
  [kFilter]: true
  errorClass: FilterError
  catch: (
    ctx: DependencyContext<Deps>,
    error: InstanceType<FilterError>,
  ) => Async<Error>
}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = Filter<
  Error,
  Dependencies
>

export function createFilter<
  FilterError extends ErrorClass,
  Deps extends Dependencies = {},
>(params: {
  errorClass: FilterError
  dependencies?: Deps
  catch: Filter<FilterError, Deps>['catch']
}): Filter<FilterError, Deps> {
  const { errorClass, catch: handler, dependencies = {} as Deps } = params

  return Object.freeze({
    errorClass,
    dependencies,
    catch: handler,
    [kFilter]: true,
  }) as Filter<FilterError, Deps>
}
