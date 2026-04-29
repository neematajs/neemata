import type { Container, HookTypes, Logger } from '@nmtjs/core'

import type { LifecycleHook } from './enums.ts'

export interface LifecycleRuntime {
  logger: Logger
  container: Container
}

export interface LifecycleHookTypes extends HookTypes {
  [LifecycleHook.BeforeInitialize]: (runtime: LifecycleRuntime) => any
  [LifecycleHook.AfterInitialize]: (runtime: LifecycleRuntime) => any
  [LifecycleHook.BeforeDispose]: (runtime: LifecycleRuntime) => any
  [LifecycleHook.AfterDispose]: (runtime: LifecycleRuntime) => any
}
