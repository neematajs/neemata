import type { ApplicationContext, Async } from './types.ts'

export interface Plugin<Options = unknown> {
  name: string
  init: (context: ApplicationContext, options: Options) => Async<void>
}

export const createPlugin = <Options = unknown>(
  name: string,
  init: Plugin<Options>['init'],
): Plugin<Options> => ({ name, init })
