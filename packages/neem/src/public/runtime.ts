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
  // Functions cannot be copied like objects, so branding mutates the input;
  // it stays unfrozen to keep the caller free to decorate it.
  return Object.assign(factory, { [NeemRuntimeHostBrand]: true })
}

export function isNeemRuntimeHostFactory(
  value: any,
): value is NeemRuntimeHostFactory {
  return typeof value === 'function' && value[NeemRuntimeHostBrand] === true
}

export function defineRuntimePlanner<
  Options = unknown,
  Data = unknown,
  const TPlanner extends NeemRuntimePlanner<Options, Data> = NeemRuntimePlanner<
    Options,
    Data
  >,
>(planner: TPlanner): TPlanner {
  // Same trade-off as defineRuntimeHost: brand in place, do not freeze.
  return Object.assign(planner, { [NeemRuntimePlannerBrand]: true })
}

export function isNeemRuntimePlanner(value: any): value is NeemRuntimePlanner {
  return typeof value === 'function' && value[NeemRuntimePlannerBrand] === true
}
