import { kPlugin } from './constants.ts'
import type { ApplicationContext, Async } from './types.ts'

export interface BasePlugin<Type = any, Options = unknown> {
  name: string
  init: (context: ApplicationContext, options: Options) => Async<Type>
}

export interface Plugin<Type = void, Options = unknown>
  extends BasePlugin<Type, Options> {
  [kPlugin]: any
}

export const createPlugin = <Options = unknown, Type = void>(
  name: string,
  init: Plugin<Type, Options>['init'],
): Plugin<Type, Options> => ({ name, init, [kPlugin]: true })
