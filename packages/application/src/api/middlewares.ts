import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { kMiddleware } from './constants.ts'

export type MiddlewareNext = (payload?: any) => any

export interface Middleware<Deps extends Dependencies = Dependencies>
  extends Dependant<Deps> {
  [kMiddleware]: true
  handle: (
    ctx: DependencyContext<Deps>,
    call: ApiCallContext,
    next: MiddlewareNext,
    payload: any,
  ) => MaybePromise<any>
}

export type AnyMiddleware = Middleware<any>

export function createMiddleware<Deps extends Dependencies = {}>(
  paramsOrHandler:
    | { dependencies?: Deps; handle: Middleware<Deps>['handle'] }
    | Middleware<Deps>['handle'],
): Middleware<Deps> {
  const { dependencies = {} as Deps, handle } =
    typeof paramsOrHandler === 'function'
      ? { handle: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({
    dependencies,
    handle,
    [kMiddleware]: true,
  }) as Middleware<Deps>
}
