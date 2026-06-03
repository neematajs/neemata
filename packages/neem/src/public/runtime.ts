import type { MaybePromise } from '@nmtjs/common'

import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimeHostFactoryParams,
  NeemRuntimePlanner,
} from '../shared/types.ts'

export const NeemRuntimeDeclarationBrand = Symbol.for(
  'neem:runtime-declaration',
)
export const NeemRuntimePlannerBrand = Symbol.for('neem:runtime-planner')
export const NeemRuntimeHostBrand = Symbol.for('neem:runtime-host')

export function defineRuntimeHost<
  Options = unknown,
  const TFactory extends (
    params: NeemRuntimeHostFactoryParams<Options>,
  ) => MaybePromise<NeemRuntimeHost> = (
    params: NeemRuntimeHostFactoryParams<Options>,
  ) => MaybePromise<NeemRuntimeHost>,
>(factory: TFactory): TFactory {
  return Object.freeze(Object.assign(factory, { [NeemRuntimeHostBrand]: true }))
}

export function isNeemRuntimeHostFactory(
  value: any,
): value is NeemRuntimeHostFactory {
  return typeof value === 'function' && value[NeemRuntimeHostBrand] === true
}

export function defineRuntimePlanner<const TPlanner extends NeemRuntimePlanner>(
  planner: TPlanner,
): TPlanner {
  return Object.freeze(
    Object.assign(planner, { [NeemRuntimePlannerBrand]: true }),
  )
}

export function isNeemRuntimePlanner(value: any): value is NeemRuntimePlanner {
  return typeof value === 'function' && value[NeemRuntimePlannerBrand] === true
}
