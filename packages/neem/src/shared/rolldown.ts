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
  ...options: [RolldownOptions | undefined, ...(RolldownOptions | undefined)[]]
) {
  function strip(options: RolldownOptions | undefined): NeemRolldownOptions {
    if (!options) return {}
    const { input, output, cwd, ...other } = options
    return other
  }
  const [first, ...rest] = options
  return merge(strip(first), ...rest.map(strip))
}
