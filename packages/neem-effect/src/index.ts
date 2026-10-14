// The application contract is Neem's: configs, runtimes, workers, planners and
// hooks written for `@nmtjs/neem` build and run unchanged on this host.
export * from '@nmtjs/neem'

import type { PluginFactory } from './internal/plugins.ts'

/** Effect-aware hooks; factories may acquire resources in their plugin scope. */
export function definePluginHooks<const T extends PluginFactory>(
  factory: T,
): T {
  return factory
}
export type { PluginFactory } from './internal/plugins.ts'
export type { PluginHooks } from './internal/hooks.ts'
