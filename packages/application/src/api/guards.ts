import type {
  Dependencies,
  Handler,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'

import type { ApiGuardContext } from './types.ts'
import { kGuard } from './constants.ts'

export type GuardHandlerFn<Deps extends Dependencies> = HandlerFn<
  Deps,
  [call: ApiGuardContext],
  boolean
>

export type GuardParams<Deps extends Dependencies> = HandlerInput<
  Deps,
  [call: ApiGuardContext],
  boolean
>

export interface Guard<
  Deps extends Dependencies = Dependencies,
> extends Handler<Deps, [call: ApiGuardContext], boolean> {
  [kGuard]: true
}

export type AnyGuard = Guard<any>

export function createGuard<Deps extends Dependencies = {}>(
  paramsOrHandler: GuardParams<Deps>,
): Guard<Deps> {
  const { dependencies = {} as Deps, handler } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({
    dependencies,
    handler,
    [kGuard]: true,
  }) as Guard<Deps>
}
