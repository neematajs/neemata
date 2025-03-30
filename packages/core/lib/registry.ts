import {
  type AnyInjectable,
  type Dependant,
  getInjectableScope,
} from './container.ts'
import { type Hook, Scope } from './enums.ts'
import { Hooks, type HookType } from './hooks.ts'
import type { Logger } from './logger.ts'

export class Registry {
  readonly hooks = new Hooks()

  constructor(
    protected readonly application: {
      logger: Logger
    },
  ) {}

  registerHooks<T extends Hooks>(hooks: T) {
    Hooks.merge(hooks, this.hooks)
  }

  registerHook<T extends Hook>(name: T, callback: HookType[T]) {
    this.hooks.add(name, callback)
  }

  *getDependants(): Generator<Dependant> {}

  clear() {
    this.hooks.clear()
  }
}

export const scopeErrorMessage = (name, scope = Scope.Global) =>
  `${name} must be a ${scope} scope (including all nested dependencies)`

export function hasInvalidScopeDeps(
  injectables: AnyInjectable[],
  scope = Scope.Global,
) {
  return injectables.some(
    (injectable) => getInjectableScope(injectable) !== scope,
  )
}
