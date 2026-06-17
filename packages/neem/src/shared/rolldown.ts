import type { RolldownOptions } from 'rolldown'
import { createDefu } from 'defu'

import type { NeemRolldownOptions } from './types.ts'

function toArray(value: any) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

const merge = createDefu((object, key, value, namespace) => {
  if (!namespace && key === 'plugins') {
    // @ts-expect-error
    object[key] = [...toArray(object[key]), ...toArray(value)]
    return true
  }
})

export function mergeRolldownOptions(
  ...options: [RolldownOptions | undefined, ...(RolldownOptions | undefined)[]]
) {
  const [first, ...rest] = options
  return merge(first ?? {}, ...rest.filter(Boolean).map((v) => v ?? {}))
}

export function mergeUserRolldownOptions(
  ...options: [
    RolldownOptions | NeemRolldownOptions | undefined,
    ...(RolldownOptions | NeemRolldownOptions | undefined)[],
  ]
) {
  function strip(
    options: RolldownOptions | NeemRolldownOptions | undefined,
  ): NeemRolldownOptions {
    if (!options) return {}
    const result: NeemRolldownOptions = pickDefined(options, [
      'plugins',
      'external',
      'moduleTypes',
      'checks',
      'tsconfig',
    ])
    const resolve = pickDefined(options.resolve, [
      'alias',
      'conditionNames',
      'extensionAlias',
      'exportsFields',
      'extensions',
      'mainFields',
      'mainFiles',
      'modules',
      'symlinks',
    ])
    const transform = pickDefined(options.transform, [
      'define',
      'inject',
      'dropLabels',
      'jsx',
    ])

    return {
      ...result,
      ...(hasKeys(resolve) ? { resolve } : {}),
      ...(hasKeys(transform) ? { transform } : {}),
    }
  }
  const [first, ...rest] = options
  return merge(strip(first), ...rest.map(strip))
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
