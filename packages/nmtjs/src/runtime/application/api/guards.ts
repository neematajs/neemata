import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type { ApiGuardContext } from './types.ts'
import { kGuard } from './constants.ts'

export type GuardCanFn<Payload> = (
  ctx: DependencyContext<any>,
  call: ApiGuardContext<Payload>,
) => MaybePromise<boolean>

export type GuardParams<Payload, Deps extends Dependencies> =
  | { dependencies?: Deps; can: GuardCanFn<Payload> }
  | GuardCanFn<Payload>

export interface Guard<Payload, Deps extends Dependencies = Dependencies>
  extends Dependant<Deps> {
  [kGuard]: true
  can: GuardCanFn<Payload>
}

export type AnyGuard<Payload = any> = Guard<Payload, any>

export function createGuard<Deps extends Dependencies = {}>(
  paramsOrHandler: GuardParams<unknown, Deps>,
): Guard<unknown, Deps> {
  const { dependencies = {} as Deps, can } =
    typeof paramsOrHandler === 'function'
      ? { can: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({ dependencies, can, [kGuard]: true }) as Guard<
    unknown,
    Deps
  >
}

export function createGuardFactory<T>(): <Deps extends Dependencies = {}>(
  paramsOrHandler: GuardParams<T, Deps>,
) => Guard<T, Deps> {
  return createGuard as any
}
