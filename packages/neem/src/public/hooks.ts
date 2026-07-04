import type { NeemPluginHooksFactory } from '../shared/types.ts'

export function definePluginHooks<const T extends NeemPluginHooksFactory>(
  factory: T,
): T {
  return factory
}
