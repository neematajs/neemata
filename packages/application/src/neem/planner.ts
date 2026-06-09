import type { MaybePromise } from '@nmtjs/common'
import type { NeemRuntimePlanner, NeemRuntimePlannerContext } from '@nmtjs/neem'
import { defineRuntimePlanner } from '@nmtjs/neem'

import type { AnyApplicationHostDefinition } from '../host.ts'
import type { NeemataRuntimeThreadOptions } from './types.ts'

export type NeemataPlannerInput<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = { instances?: number; transports: NeemataRuntimeThreadOptions<THost> }

export type NeemataPlannerFactory<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = (ctx: NeemRuntimePlannerContext) => MaybePromise<NeemataPlannerInput<THost>>

export type NeemataRuntimePlanner<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = NeemRuntimePlanner<undefined, NeemataRuntimeThreadOptions<THost>>

export function defineNeemataPlanner<
  const THost extends
    AnyApplicationHostDefinition = AnyApplicationHostDefinition,
>(planner: NeemataPlannerFactory<THost>): NeemataRuntimePlanner<THost> {
  return defineRuntimePlanner<NeemataRuntimePlanner<THost>>(async (ctx) => {
    const input = await planner(ctx)
    const instances = input.instances ?? 1
    return {
      workers: Array.from({ length: instances }, () => input.transports),
    }
  })
}
