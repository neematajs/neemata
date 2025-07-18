import type { Callback } from '@nmtjs/common'
import { kHookCollection } from './constants.ts'
import type { Hook } from './enums.ts'

export interface HookType {
  [key: string]: (...args: any[]) => any
  // [Hook.AfterInitialize]: () => any
  // [Hook.BeforeStart]: () => any
  // [Hook.AfterStart]: () => any
  // [Hook.BeforeStop]: () => any
  // [Hook.AfterStop]: () => any
  // [Hook.BeforeTerminate]: () => any
  // [Hook.AfterTerminate]: () => any
  // [Hook.OnConnect]: (...args: any[]) => any
  // [Hook.OnDisconnect]: (...args: any[]) => any
}

export type CallHook<T extends string> = (
  hook: T,
  ...args: T extends keyof HookType ? Parameters<HookType[T]> : any[]
) => Promise<void>

export class Hooks {
  static merge(from: Hooks, to: Hooks) {
    for (const [name, callbacks] of from[kHookCollection]) {
      for (const callback of callbacks) {
        to.add(name, callback)
      }
    }
  }

  [kHookCollection] = new Map<string, Set<Callback>>()

  add(name: string, callback: Callback) {
    let hooks = this[kHookCollection].get(name)
    if (!hooks) this[kHookCollection].set(name, (hooks = new Set()))
    hooks.add(callback)
    return () => this.remove(name, callback)
  }

  remove(name: string, callback: Callback) {
    const hooks = this[kHookCollection].get(name)
    if (hooks) hooks.delete(callback)
  }

  async call<T extends string | Hook>(
    name: T,
    options: { concurrent?: boolean; reverse?: boolean } | undefined,
    ...args: T extends Hook ? Parameters<HookType[T]> : any[]
  ) {
    const { concurrent = true, reverse = false } = options ?? {}
    const hooks = this[kHookCollection].get(name)
    if (!hooks) return
    const hooksArr = Array.from(hooks)
    if (concurrent) {
      await Promise.all(hooksArr.map((hook) => hook(...args)))
    } else {
      if (reverse) hooksArr.reverse()
      for (const hook of hooksArr) await hook(...args)
    }
  }

  clear() {
    this[kHookCollection].clear()
  }
}

export const createErrForHook = (hook: Hook | (object & string)) =>
  `Error during [${hook}] hook`
