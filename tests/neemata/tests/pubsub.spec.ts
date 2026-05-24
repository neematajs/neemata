import type { PubSubAdapter, PubSubMessage } from '@nmtjs/pubsub'
import {
  createApp,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from '@nmtjs/application'
import { createLogger } from '@nmtjs/core'
import { createPubSubPlugin, publish, subscribe } from '@nmtjs/pubsub'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

class MemoryPubSubAdapter implements PubSubAdapter {
  private readonly messages = new Map<string, unknown[]>()
  initializeCalls = 0
  disposeCalls = 0

  async initialize() {
    this.initializeCalls++
  }

  async dispose() {
    this.disposeCalls++
  }

  async publish(channel: string, payload: unknown): Promise<boolean> {
    const messages = this.messages.get(channel) ?? []
    messages.push(payload)
    this.messages.set(channel, messages)
    return true
  }

  async *subscribe(channel: string): AsyncGenerator<PubSubMessage> {
    for (const payload of this.messages.get(channel) ?? []) {
      yield { channel, payload }
    }
  }
}

const chatChannel = 'chat:room-1'

describe('Neemata pubsub integration', () => {
  it('provides publish and subscribe injectables through app plugin', async () => {
    const adapter = new MemoryPubSubAdapter()
    const procedure = createProcedure({
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
      dependencies: { publish, subscribe },
      async handler(ctx, input) {
        await ctx.publish(chatChannel, input)
        const stream = await ctx.subscribe<{ text: string }>(chatChannel)

        for await (const event of stream) {
          return event.payload
        }

        throw new Error('Expected subscription event')
      },
    })
    const app = createApp(
      defineApplication({
        router: createRootRouter([
          createRouter({ routes: { ping: procedure } }),
        ]),
        plugins: [createPubSubPlugin({ adapter: () => adapter })],
      }),
      {
        logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
        transports: {},
      },
    )

    await app.start()
    const ctx = await app.container.createContext({ publish, subscribe })

    await ctx.publish(chatChannel, { text: 'hello' })
    const stream = await ctx.subscribe<{ text: string }>(chatChannel)

    const events: unknown[] = []
    for await (const event of stream) events.push(event)

    await app.stop()

    expect(events).toEqual([
      { channel: chatChannel, payload: { text: 'hello' } },
    ])
    expect(adapter.initializeCalls).toBe(1)
    expect(adapter.disposeCalls).toBe(1)
  })
})
