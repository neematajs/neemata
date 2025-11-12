import type { Async } from '@nmtjs/common'

import type {
  Dependant,
  Dependencies,
  DependencyContext,
} from './injectables.ts'
import type { HookTypes } from './types.ts'
import { kHook } from './constants.ts'

export type AnyHook = Hook<string, any>
export interface Hook<
  H extends keyof HookTypes | (object & string) = string,
  Deps extends Dependencies = {},
> extends Dependant<Deps> {
  [kHook]: any
  name: H
  handler: (
    ctx: DependencyContext<Deps>,
    ...args: H extends keyof HookTypes ? HookTypes[H] : unknown[]
  ) => Async<any>
}

export function createHook<
  Name extends keyof HookTypes | (object & string),
  Deps extends Dependencies = {},
>(params: {
  name: Name
  dependencies?: Deps
  handler: Hook<Name, Deps>['handler']
}): Hook<Name, Deps> {
  const { name, handler, dependencies = {} as Deps } = params
  return Object.freeze({ [kHook]: true, name, handler, dependencies }) as any
}
