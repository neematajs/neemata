import type { NestedHooks } from 'hookable'
import { Hookable } from 'hookable'

import type { HookTypes } from './types.ts'

export type HooksConfig<T extends HookTypes = HookTypes> = NestedHooks<T>

export class Hooks<T extends HookTypes = HookTypes> extends Hookable<T> {
  // phantom: carries the config shape for `Hooks<T>['_']['config']` lookups
  _!: { config: HooksConfig<T> }
}
