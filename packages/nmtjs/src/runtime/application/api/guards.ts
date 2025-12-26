import type { MaybePromise } from '@nmtjs/common'
import type { Dependant, Dependencies, DependencyContext } from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { kGuard } from './constants.ts'

export interface Guard<Deps extends Dependencies = Dependencies>
  extends Dependant<Deps> {
  [kGuard]: true
  can: (
    ctx: DependencyContext<Deps>,
    call: ApiCallContext,
  ) => MaybePromise<boolean>
}

export type AnyGuard = Guard<any>

export function createGuard<Deps extends Dependencies = {}>(
  paramsOrHandler:
    | { dependencies?: Deps; can: Guard<Deps>['can'] }
    | Guard<Deps>['can'],
): Guard<Deps> {
  const { dependencies = {} as Deps, can } =
    typeof paramsOrHandler === 'function'
      ? { can: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({ dependencies, can, [kGuard]: true }) as Guard<Deps>
}
