import type { RuntimePlugin } from '@nmtjs/application'
import type { MaybePromise } from '@nmtjs/common'
import type { Container, Logger } from '@nmtjs/core'
import { LifecycleHook } from '@nmtjs/application'
import { provision } from '@nmtjs/core'

import type { EventingAdapter } from './adapter.ts'
import { eventingAdapter, produce } from './injectables.ts'
import { EventingManager } from './manager.ts'

export type EventingPluginContext = { logger: Logger; container: Container }

export type EventingPluginOptions = {
  adapter: (ctx: EventingPluginContext) => MaybePromise<EventingAdapter>
}

export function createEventingPlugin(
  options: EventingPluginOptions,
): RuntimePlugin {
  let adapter: EventingAdapter | undefined

  return {
    name: 'eventing',
    hooks: {
      [LifecycleHook.BeforeInitialize]: async (ctx) => {
        adapter = await options.adapter(ctx)
        await adapter.initialize()

        const manager = new EventingManager({ logger: ctx.logger, adapter })

        ctx.container.provide([
          provision(eventingAdapter, adapter),
          provision(produce, (...args) => manager.produce(...args)),
        ])
      },
      [LifecycleHook.BeforeDispose]: async () => {
        await adapter?.dispose()
        adapter = undefined
      },
    },
  }
}
