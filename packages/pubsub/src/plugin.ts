import type { AnyInjectable, ExecutionEnvironmentPlugin } from '@nmtjs/core'
import {
  CoreInjectables,
  createFactoryInjectable,
  provision,
} from '@nmtjs/core'

import type { PubSubAdapter } from './adapter.ts'
import { publish, pubsubAdapter, subscribe } from './injectables.ts'
import { PubSubManager } from './manager.ts'

export type PubSubPluginOptions = { adapter: AnyInjectable<PubSubAdapter> }

export function createPubSubPlugin(
  options: PubSubPluginOptions,
): ExecutionEnvironmentPlugin {
  const manager = createFactoryInjectable({
    dependencies: {
      adapter: options.adapter,
      logger: CoreInjectables.logger,
    },
    create: ({ adapter, logger }) => new PubSubManager({ logger, adapter }),
  })

  return {
    name: 'pubsub',
    provisions: [
      provision(pubsubAdapter, options.adapter),
      provision(
        publish,
        createFactoryInjectable({
          dependencies: { manager },
          create: ({ manager }) => manager.publish.bind(manager),
        }),
      ),
      provision(
        subscribe,
        createFactoryInjectable({
          dependencies: { manager },
          create: ({ manager }) => manager.subscribe.bind(manager),
        }),
      ),
    ],
  }
}
