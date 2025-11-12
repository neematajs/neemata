import type { Async } from '@nmtjs/common'

import { kPlugin } from './constants.ts'

export interface Plugin<Type = void, Options = unknown, Context = unknown> {
  name: string
  factory: (context: Context, options: Options) => Async<Type>
  [kPlugin]: any
}

export const createPlugin = <Type = void, Options = unknown, Context = unknown>(
  name: string,
  factory: Plugin<Type, Options, Context>['factory'],
): Plugin<Type, Options, Context> => ({ name, factory, [kPlugin]: true })

export const isPlugin = (value: any): value is Plugin => kPlugin in value
