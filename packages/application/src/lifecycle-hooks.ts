import type { NestedHooks } from 'hookable'
import { Hookable } from 'hookable'

import type { LifecycleHookTypes } from './types.ts'
import { LifecycleHook } from './enums.ts'

export class LifecycleHooks extends Hookable<LifecycleHookTypes> {
  _!: { config: NestedHooks<LifecycleHookTypes> }

  beforeTerminateSignal() {
    const abortController = new AbortController()
    const unregister = this.hookOnce(LifecycleHook.DisposeBefore, () =>
      abortController.abort(),
    )
    return { signal: abortController.signal, unregister }
  }

  createSignal(hook: LifecycleHook) {
    const controller = new AbortController()
    const unregister = this.hookOnce(hook, () => controller.abort())
    return { controller, signal: controller.signal, unregister }
  }
}
