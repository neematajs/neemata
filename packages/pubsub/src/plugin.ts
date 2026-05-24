import type { RuntimePlugin } from '@nmtjs/application'
import type { MaybePromise } from '@nmtjs/common'
import type { Container, Logger } from '@nmtjs/core'
import { LifecycleHook } from '@nmtjs/application'
import { provision } from '@nmtjs/core'

import type { PubSubAdapter } from './adapter.ts'
import { publish, pubsubAdapter, subscribe } from './injectables.ts'
import { PubSubManager } from './manager.ts'

export type PubSubPluginContext = { logger: Logger; container: Container }

export type PubSubPluginOptions = {
  adapter: (ctx: PubSubPluginContext) => MaybePromise<PubSubAdapter>
}

export function createPubSubPlugin(
  options: PubSubPluginOptions,
): RuntimePlugin {
  let adapter: PubSubAdapter | undefined

  return {
    name: 'pubsub',
    hooks: {
      [LifecycleHook.BeforeInitialize]: async (ctx) => {
        adapter = await options.adapter(ctx)
        await adapter.initialize()

        const manager = new PubSubManager({ logger: ctx.logger, adapter })

        ctx.container.provide([
          provision(pubsubAdapter, adapter),
          provision(publish, manager.publish.bind(manager)),
          provision(subscribe, manager.subscribe.bind(manager)),
        ])
      },
      [LifecycleHook.BeforeDispose]: async () => {
        await adapter?.dispose()
        adapter = undefined
      },
    },
  }
}
