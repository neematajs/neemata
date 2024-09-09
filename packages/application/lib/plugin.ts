import type { ApplicationContext, Async } from './types.ts'

export interface Plugin<Type = void, Options = unknown> {
  name: string
  init: (context: ApplicationContext, options: Options) => Async<Type>
}

export const createPlugin = <Options = unknown, Type = void>(
  name: string,
  init: Plugin<Type, Options>['init'],
): Plugin<Type, Options> => ({ name, init })
