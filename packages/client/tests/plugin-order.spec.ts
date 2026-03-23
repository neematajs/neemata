import { ServerMessageType } from '@nmtjs/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ClientPlugin,
  ClientPluginInstance,
} from '../src/plugins/types.ts'
import { StaticClient } from '../src/clients/static.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
} from './_helpers/transports.ts'

describe('Plugin order', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls init/connect in registration order and disconnect/dispose in reverse order', async () => {
    const events: string[] = []

    const mkPlugin = (name: string): ClientPlugin => {
      return () =>
        ({
          name,
          onInit: () => {
            events.push(`init:${name}`)
          },
          onConnect: () => {
            events.push(`connect:${name}`)
          },
          onDisconnect: () => {
            events.push(`disconnect:${name}`)
          },
          dispose: () => {
            events.push(`dispose:${name}`)
          },
        }) satisfies ClientPluginInstance
    }

    const transport = createMockBidirectionalTransport()
    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [mkPlugin('a'), mkPlugin('b'), mkPlugin('c')],
      },
      transport.factory,
      {},
    )

    expect(events.join('|')).toBe('init:a|init:b|init:c')

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    expect(events.join('|')).toBe(
      'init:a|init:b|init:c|connect:a|connect:b|connect:c',
    )

    transport.simulateDisconnect('server')
    await vi.waitFor(() => {
      expect(events.join('|')).toBe(
        'init:a|init:b|init:c|connect:a|connect:b|connect:c|disconnect:c|disconnect:b|disconnect:a',
      )
    })

    client.dispose()

    expect(events.join('|')).toBe(
      'init:a|init:b|init:c|connect:a|connect:b|connect:c|disconnect:c|disconnect:b|disconnect:a|dispose:c|dispose:b|dispose:a',
    )
  })

  it('calls onServerMessage in registration order', async () => {
    const events: string[] = []

    const mkPlugin = (name: string): ClientPlugin => {
      return () =>
        ({
          name,
          onServerMessage: () => events.push(`message:${name}`),
        }) satisfies ClientPluginInstance
    }

    const transport = createMockBidirectionalTransport()

    const client = new StaticClient(
      {
        ...createBaseOptions(),
        plugins: [mkPlugin('a'), mkPlugin('b'), mkPlugin('c')],
      },
      transport.factory,
      {},
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    ;(client.core.protocol as any).decodeMessage = () => ({
      type: ServerMessageType.Pong,
      nonce: 1,
    })

    transport.emitMessage(new Uint8Array())
    await Promise.resolve()

    expect(events.join('|')).toBe('message:a|message:b|message:c')
  })
})
