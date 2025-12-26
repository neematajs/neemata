import type { NestedHooks } from 'hookable'
import { Hookable } from 'hookable'

import type { HookTypes } from './types.ts'

export class Hooks<T extends HookTypes = HookTypes> extends Hookable<T> {
  _!: { config: NestedHooks<T> }

  createSignal<H extends keyof T>(
    hook: H,
  ): {
    controller: AbortController
    signal: AbortSignal
    unregister: () => void
  } {
    const controller = new AbortController()
    const unregister = this.hookOnce(
      String(hook),
      //@ts-expect-error
      () => controller.abort(),
    )
    return { controller, signal: controller.signal, unregister }
  }
}
