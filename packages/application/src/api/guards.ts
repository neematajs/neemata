import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type { ApiGuardContext } from './types.ts'
import { kGuard } from './constants.ts'

export type GuardCanFn<Deps extends Dependencies> = (
  ctx: DependencyContext<Deps>,
  call: ApiGuardContext,
) => MaybePromise<boolean>

export type GuardParams<Deps extends Dependencies> =
  | { dependencies?: Deps; can: GuardCanFn<Deps> }
  | GuardCanFn<Deps>

export interface Guard<Deps extends Dependencies = Dependencies>
  extends Dependant<Deps> {
  [kGuard]: true
  can: GuardCanFn<Deps>
}

export type AnyGuard = Guard<any>

export function createGuard<Deps extends Dependencies = {}>(
  paramsOrHandler: GuardParams<Deps>,
): Guard<Deps> {
  const { dependencies = {} as Deps, can } =
    typeof paramsOrHandler === 'function'
      ? { can: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({ dependencies, can, [kGuard]: true }) as Guard<Deps>
}
