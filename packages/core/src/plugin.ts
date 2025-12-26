import type { MaybePromise } from '@nmtjs/common'

import { kPlugin } from './constants.ts'

export interface Plugin<Type = void, Context = unknown> {
  name: string
  factory: (context: Context) => MaybePromise<Type>
  [kPlugin]: any
}

export const createPlugin = <Type = void, Context = unknown>(
  name: string,
  factory: Plugin<Type, Context>['factory'],
): Plugin<Type, Context> => ({ name, factory, [kPlugin]: true })

export const isPlugin = (value: any): value is Plugin => kPlugin in value
