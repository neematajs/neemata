import type { Container } from './container.ts'
import type { Hook } from './hook.ts'
import type { Registry } from './registry.ts'
import type { HookTypes } from './types.ts'

export type HookCallOptions = { concurrent: boolean }

export class Hooks {
  constructor(
    protected runtime: { container: Container; registry: Registry },
  ) {}

  get container() {
    return this.runtime.container
  }

  get registry() {
    return this.runtime.registry
  }

  call<T extends string>(
    hookName: T,
    ...args: T extends keyof HookTypes ? HookTypes[T] : any[]
  ) {
    return this._call(hookName, args, { concurrent: false })
  }

  callConcurrent<T extends string>(
    hookName: T,
    ...args: T extends keyof HookTypes ? HookTypes[T] : any[]
  ) {
    return this._call(hookName, args, { concurrent: true })
  }

  protected async _call<T extends string>(
    hookName: T,
    args: T extends keyof HookTypes ? HookTypes[T] : any[],
    options: HookCallOptions,
  ) {
    const hooks = this.registry.hooks.get(hookName)
    if (!hooks) return
    if (options.concurrent) {
      const runs = hooks.map((hook) => this._callHook(hook, args))
      await Promise.all(runs)
    } else {
      for (const hook of hooks) {
        await this._callHook(hook, args)
      }
    }
  }

  protected async _callHook(hook: Hook, args: any[]) {
    const context = await this.container.createContext(hook.dependencies)
    await hook.handler(context, ...args)
  }
}
