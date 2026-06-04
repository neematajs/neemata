import type { NeemRuntimePlan } from '@nmtjs/neem'
import { defineRuntimePlanner } from '@nmtjs/neem'

import type { AnyApplicationHostDefinition } from '../host.ts'
import type { NeemataRuntimeThreadOptions } from './types.ts'

export type NeemataPlannerInput<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = { instances?: number; transports: NeemataRuntimeThreadOptions<THost> }

export function defineNeemataPlanner<
  const THost extends
    AnyApplicationHostDefinition = AnyApplicationHostDefinition,
>(planner: () => NeemataPlannerInput<THost>) {
  return defineRuntimePlanner(
    (): NeemRuntimePlan<unknown, NeemataRuntimeThreadOptions<THost>> => {
      const input = planner()
      const instances = input.instances ?? 1
      return {
        workers: Array.from({ length: instances }, () => input.transports),
      }
    },
  )
}
