import type { RuntimePlugin } from '@nmtjs/application'
import type { AnyInjectable } from '@nmtjs/core'
import { LifecycleHook } from '@nmtjs/application'
import { provision } from '@nmtjs/core'

import type { PubSubAdapter } from './adapter.ts'
import { publish, pubsubAdapter, subscribe } from './injectables.ts'
import { PubSubManager } from './manager.ts'

export type PubSubPluginOptions = { adapter: AnyInjectable<PubSubAdapter> }

export function createPubSubPlugin(
  options: PubSubPluginOptions,
): RuntimePlugin {
  return {
    name: 'pubsub',
    hooks: {
      [LifecycleHook.BeforeInitialize]: async (ctx) => {
        const adapter = await ctx.container.resolve(options.adapter)
        const manager = new PubSubManager({ logger: ctx.logger, adapter })
        ctx.container.provide([
          provision(pubsubAdapter, adapter),
          provision(publish, manager.publish.bind(manager)),
          provision(subscribe, manager.subscribe.bind(manager)),
        ])
      },
    },
  }
}
