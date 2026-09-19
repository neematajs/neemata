import type {
  Dependencies,
  Handler,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'
import { createHandler } from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { kMiddleware } from './constants.ts'

export type MiddlewareNext = (payload?: any) => any

export type MiddlewareArgs = [
  call: ApiCallContext,
  next: MiddlewareNext,
  payload: any,
]

export type MiddlewareHandlerFn<Deps extends Dependencies> = HandlerFn<
  Deps,
  MiddlewareArgs,
  any
>

export type MiddlewareParams<Deps extends Dependencies> = HandlerInput<
  Deps,
  MiddlewareArgs,
  any
>

export interface Middleware<
  Deps extends Dependencies = Dependencies,
> extends Handler<Deps, MiddlewareArgs, any> {
  [kMiddleware]: true
}

export type AnyMiddleware = Middleware<any>

export function createMiddleware<Deps extends Dependencies = {}>(
  paramsOrHandler: MiddlewareParams<Deps>,
): Middleware<Deps> {
  return Object.freeze({
    ...createHandler(paramsOrHandler),
    [kMiddleware]: true,
  } satisfies Middleware<Deps>)
}
