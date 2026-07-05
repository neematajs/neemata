import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  NeemataApplication,
} from '@nmtjs/application'
import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { createFactoryInjectable, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { expect, it } from 'vitest'

import type { PubSubAdapter } from '../src/adapter.ts'
import { createPubSubPlugin, publish } from '../src/index.ts'

class TestPubSubAdapter implements PubSubAdapter {
  readonly published: Array<{ channel: string; payload: unknown }> = []

  async publish(channel: string, payload: unknown): Promise<boolean> {
    this.published.push({ channel, payload })
    return true
  }

  async *subscribe(): AsyncIterable<never> {}
}

it('provides publish before global application dependencies initialize', async () => {
  const adapter = new TestPubSubAdapter()
  const adapterInjectable = createFactoryInjectable(() => adapter)
  const channel = SubscriptionContract({
    namespace: 'chat',
    params: t.object({ roomId: t.string() }),
    key: ({ roomId }) => roomId,
    events: {
      message: EventContract({ payload: t.object({ text: t.string() }) }),
    },
  })
  const publisherService = createFactoryInjectable({
    dependencies: { publish },
    create: ({ publish }) => ({
      notify: () =>
        publish(channel.events.message, { roomId: 'general' }, { text: 'hi' }),
    }),
  })
  const router = createRootRouter([
    createRouter({
      routes: {
        notify: createProcedure({
          dependencies: { publisherService },
          handler: async () => ({ ok: true }),
        }),
      },
    }),
  ] as const)
  const runtime = new NeemataApplication(
    defineApplication({
      router,
      plugins: [createPubSubPlugin({ adapter: adapterInjectable })],
    }),
    { logger: createLogger({ pinoOptions: { enabled: false } }, 'test') },
  )

  try {
    await runtime.initialize()
    const service = await runtime.container.resolve(publisherService)

    await expect(service.notify()).resolves.toBe(true)
    expect(adapter.published).toEqual([
      {
        channel: 'chat:general',
        payload: { event: 'message', payload: { text: 'hi' } },
      },
    ])
  } finally {
    await runtime.dispose()
  }
})
