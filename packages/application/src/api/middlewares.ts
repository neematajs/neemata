import type {
  Dependencies,
  Handler,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { kMiddleware } from './constants.ts'

export type MiddlewareNext = (payload?: any) => any

export type MiddlewareHandlerFn<Deps extends Dependencies> = HandlerFn<
  Deps,
  [call: ApiCallContext, next: MiddlewareNext, payload: any],
  any
>

export interface Middleware<
  Deps extends Dependencies = Dependencies,
> extends Handler<
  Deps,
  [call: ApiCallContext, next: MiddlewareNext, payload: any],
  any
> {
  [kMiddleware]: true
}

export type AnyMiddleware = Middleware<any>

export function createMiddleware<Deps extends Dependencies = {}>(
  paramsOrHandler: HandlerInput<
    Deps,
    [call: ApiCallContext, next: MiddlewareNext, payload: any],
    any
  >,
): Middleware<Deps> {
  const { dependencies = {} as Deps, handler } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({
    dependencies,
    handler,
    [kMiddleware]: true,
  }) as Middleware<Deps>
}
