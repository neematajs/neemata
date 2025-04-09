import type { Async } from '../../common/src/index.ts'
import { kPlugin } from './constants.ts'
import type { PluginContext } from './types.ts'

export interface BasePlugin<
  Type = any,
  Options = unknown,
  Context extends PluginContext = PluginContext,
> {
  name: string
  init: (context: Context, options: Options) => Async<Type>
}

export interface Plugin<
  Type = void,
  Options = unknown,
  Context extends PluginContext = PluginContext,
> extends BasePlugin<Type, Options, Context> {
  [kPlugin]: any
}

export const createPlugin = <Options = unknown, Type = void>(
  name: string,
  init: Plugin<Type, Options>['init'],
): Plugin<Type, Options> => ({ name, init, [kPlugin]: true })
