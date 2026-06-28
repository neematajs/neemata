import type { Dependant, Dependencies, HandlerFn, HookTypes } from '@nmtjs/core'
import { kHook } from '@nmtjs/core'

export type AnyHook = Hook<HookTypes, string, any>
type CustomHookName = string & {}

export interface Hook<
  T extends HookTypes = HookTypes,
  H extends string = string,
  Deps extends Dependencies = {},
> extends Dependant<Deps> {
  [kHook]: any
  name: H
  handler: HandlerFn<
    Deps,
    H extends keyof T ? Parameters<T[H]> : unknown[],
    any
  >
}

export function createHook<
  Types extends HookTypes = HookTypes,
  Name extends Extract<keyof Types, string> | CustomHookName = CustomHookName,
  Deps extends Dependencies = {},
>(params: {
  name: Name
  dependencies?: Deps
  handler: Hook<Types, Name, Deps>['handler']
}): Hook<Types, Name, Deps> {
  const { name, handler, dependencies = {} as Deps } = params
  return Object.freeze({ [kHook]: true, name, handler, dependencies }) as any
}

export function createApplicationHookFactory<Types extends HookTypes>() {
  return <
    Name extends Extract<keyof Types, string> | CustomHookName = CustomHookName,
    Deps extends Dependencies = {},
  >(params: {
    name: Name
    dependencies?: Deps
    handler: Hook<Types, Name, Deps>['handler']
  }): Hook<Types, Name, Deps> => {
    return createHook<Types, Name, Deps>(params)
  }
}
