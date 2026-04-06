import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type { ApiGuardContext } from './types.ts'
import { kGuard } from './constants.ts'

export type GuardCanFn<Payload, Deps extends Dependencies> = (
  ctx: DependencyContext<Deps>,
  call: ApiGuardContext<Payload>,
) => MaybePromise<boolean>

export type GuardParams<Payload, Deps extends Dependencies> =
  | { dependencies?: Deps; can: GuardCanFn<Payload, Deps> }
  | GuardCanFn<Payload, Deps>

export interface Guard<Payload, Deps extends Dependencies = Dependencies>
  extends Dependant<Deps> {
  [kGuard]: true
  can: GuardCanFn<Payload, Deps>
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
