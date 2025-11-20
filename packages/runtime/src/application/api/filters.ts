import type { Async, ErrorClass } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import { kFilter } from './constants.ts'

export interface Filter<
  Error extends ErrorClass = ErrorClass,
  Deps extends Dependencies = Dependencies,
> extends Dependant<Deps> {
  [kFilter]: true
  errorClass: Error
  catch: (
    ctx: DependencyContext<Deps>,
    error: InstanceType<Error>,
  ) => Async<Error>
}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = Filter<
  Error,
  Dependencies
>

export function createFilter<
  Error extends ErrorClass,
  Deps extends Dependencies = {},
>(params: {
  errorClass: Error
  dependencies?: Deps
  catch: Filter<Error, Deps>['catch']
}): Filter<Error, Deps> {
  const { errorClass, catch: handler, dependencies = {} as Deps } = params

  return Object.freeze({
    errorClass,
    dependencies,
    catch: handler,
    [kFilter]: true,
  }) as Filter<Error, Deps>
}
