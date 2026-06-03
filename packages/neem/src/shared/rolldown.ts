import type { RolldownOptions } from 'rolldown'
import { createDefu } from 'defu'

import type { NeemRolldownOptions } from './types.ts'

const merge = createDefu((object, key, value, namespace) => {
  if (!namespace) {
    switch (key) {
      case 'output':
      case 'input': {
        // @ts-expect-error
        object[key] = [
          ...(Array.isArray(value) ? value : [value]),
          ...(Array.isArray(object[key]) ? object[key] : [object[key]]),
        ]
        return true
      }
    }
  }
})

export function mergeRolldownOptions(
  ...options: [RolldownOptions | undefined, ...(RolldownOptions | undefined)[]]
) {
  const inputs = options.toReversed()
  const [last, ...rest] = inputs
  return merge(last ?? {}, ...rest.filter(Boolean).map((v) => v ?? {}))
}

export function mergeUserRolldownOptions(
  ...options: [RolldownOptions | undefined, ...(RolldownOptions | undefined)[]]
) {
  function strip(options: RolldownOptions): NeemRolldownOptions {
    const { input, output, cwd, ...other } = options
    return other
  }
  const inputs = options.toReversed()
  const [last, ...rest] = inputs
  let target = { ...strip(last ?? {}) }
  for (const options of rest) {
    target = merge(target, strip(options ?? {}))
  }
  return target
}
