import type { Injection } from '@nmtjs/core'

import type { LifecycleHooks } from './hooks.ts'

export interface RuntimePlugin {
  name: string
  hooks?: LifecycleHooks['_']['config']
  injections?: Injection[]
}

export function createPlugin<T extends RuntimePlugin>(plugin: T): T {
  return plugin
}
