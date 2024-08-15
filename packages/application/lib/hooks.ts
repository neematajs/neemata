import type { Hook } from './constants.ts'
import type { Callback, HooksInterface } from './types.ts'

export class Hooks {
  static merge(from: Hooks, to: Hooks) {
    for (const [name, callbacks] of from.collection) {
      for (const callback of callbacks) {
        to.add(name, callback)
      }
    }
  }

  collection = new Map<string, Set<Callback>>()

  add(name: string, callback: Callback) {
    let hooks = this.collection.get(name)
    if (!hooks) this.collection.set(name, (hooks = new Set()))
    hooks.add(callback)
    return () => this.remove(name, callback)
  }

  remove(name: string, callback: Callback) {
    const hooks = this.collection.get(name)
    if (hooks) hooks.delete(callback)
  }

  async call<T extends string | Hook>(
    name: T,
    options: { concurrent?: boolean; reverse?: boolean } | undefined,
    ...args: T extends Hook ? Parameters<HooksInterface[T]> : any[]
  ) {
    const { concurrent = true, reverse = false } = options ?? {}
    const hooks = this.collection.get(name)
    if (!hooks) return
    if (concurrent) {
      // TODO: add some logging maybe?
      await Promise.allSettled(Array.from(hooks).map((hook) => hook(...args)))
    } else {
      const hooksArr = Array.from(hooks)
      if (reverse) hooksArr.reverse()
      for (const hook of hooksArr) await hook(...args)
    }
  }

  clear() {
    this.collection.clear()
  }
}
