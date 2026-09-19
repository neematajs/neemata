import type { RolldownOptions } from 'rolldown'
import { createDefu } from 'defu'

import type { NeemRolldownOptions } from './types.ts'

/** Rolldown options a Neem user may set; everything else is Neem's topology. */
export const ROLLDOWN_KEYS = [
  'plugins',
  'external',
  'moduleTypes',
  'checks',
  'tsconfig',
] as const

export const ROLLDOWN_RESOLVE_KEYS = [
  'alias',
  'conditionNames',
  'extensionAlias',
  'exportsFields',
  'extensions',
  'mainFields',
  'mainFiles',
  'modules',
  'symlinks',
] as const

export const ROLLDOWN_TRANSFORM_KEYS = [
  'define',
  'inject',
  'dropLabels',
  'jsx',
] as const

type Layers<T> = [T | undefined, ...(T | undefined)[]]

const merge = createDefu(
  (
    object: Record<PropertyKey, unknown>,
    key: PropertyKey,
    value: unknown,
    namespace: string,
  ) => {
    // Plugins compose instead of overriding: the lower-precedence layer's
    // plugins must keep running before the higher-precedence layer's.
    if (namespace || key !== 'plugins') return false
    object[key] = [...toArray(object[key]), ...toArray(value)]
    return true
  },
)

export function mergeRolldownOptions(
  ...options: Layers<RolldownOptions>
): RolldownOptions {
  const [first, ...rest] = options
  return merge(first ?? {}, ...rest.filter((layer) => layer !== undefined))
}

export function mergeUserRolldownOptions(
  ...options: Layers<RolldownOptions | NeemRolldownOptions>
): NeemRolldownOptions {
  const [first, ...rest] = options
  return merge(strip(first), ...rest.map(strip))
}

function strip(
  options: RolldownOptions | NeemRolldownOptions | undefined,
): NeemRolldownOptions {
  if (!options) return {}

  const picked: NeemRolldownOptions = pickDefined(options, ROLLDOWN_KEYS)
  const resolve = pickDefined(options.resolve, ROLLDOWN_RESOLVE_KEYS)
  const transform = pickDefined(options.transform, ROLLDOWN_TRANSFORM_KEYS)

  return {
    ...picked,
    ...(hasKeys(resolve) ? { resolve } : {}),
    ...(hasKeys(transform) ? { transform } : {}),
  }
}

function toArray(value: unknown): unknown[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function pickDefined<T extends object, const TKey extends keyof T>(
  value: T | undefined,
  keys: readonly TKey[],
): Pick<T, TKey> {
  const result = {} as Pick<T, TKey>
  if (!value) return result

  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  return result
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0
}
