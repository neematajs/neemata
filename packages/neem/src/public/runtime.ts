import type {
  NeemRuntimeHostFactory,
  NeemRuntimePlanner,
} from '../shared/types.ts'

export const NeemRuntimeDeclarationBrand = Symbol.for(
  'neem:runtime-declaration',
)
export const NeemRuntimePlannerBrand = Symbol.for('neem:runtime-planner')
export const NeemRuntimeHostBrand = Symbol.for('neem:runtime-host')

export function defineRuntimeHost<
  Options = unknown,
  const T extends NeemRuntimeHostFactory<Options> =
    NeemRuntimeHostFactory<Options>,
>(factory: T): T {
  // Functions cannot be copied like objects, so branding mutates the input;
  // it stays unfrozen to keep the caller free to decorate it.
  return Object.assign(factory, { [NeemRuntimeHostBrand]: true })
}

export function isNeemRuntimeHostFactory(
  value: unknown,
): value is NeemRuntimeHostFactory {
  // Read the brand off the raw value: narrowing to `Function` first loses the
  // symbol index signature needed to look it up.
  const brands = value as Record<symbol, unknown>
  return typeof value === 'function' && brands[NeemRuntimeHostBrand] === true
}

export function defineRuntimePlanner<
  Options = unknown,
  Data = unknown,
  const T extends NeemRuntimePlanner<Options, Data> = NeemRuntimePlanner<
    Options,
    Data
  >,
>(planner: T): T {
  // Same trade-off as defineRuntimeHost: brand in place, do not freeze.
  return Object.assign(planner, { [NeemRuntimePlannerBrand]: true })
}

export function isNeemRuntimePlanner(
  value: unknown,
): value is NeemRuntimePlanner {
  const brands = value as Record<symbol, unknown>
  return typeof value === 'function' && brands[NeemRuntimePlannerBrand] === true
}
