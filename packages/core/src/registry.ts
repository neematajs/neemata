import type { AnyHook, Hook } from '@nmtjs/core'

import type { AnyInjectable, Dependant } from './injectables.ts'
import type { Logger } from './logger.ts'
import { Scope } from './enums.ts'
import { getInjectableScope } from './injectables.ts'

export class Registry {
  readonly hooks = new Map<string, Hook[]>()

  constructor(protected readonly application: { logger: Logger }) {}

  registerHook(hook: AnyHook) {
    let hooks = this.hooks.get(hook.name)
    if (!hooks) {
      hooks = []
      this.hooks.set(hook.name, hooks)
    }
    hooks.push(hook)
  }

  *getDependants(): Generator<Dependant> {
    for (const hooks of this.hooks.values()) {
      yield* hooks
    }
  }

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
