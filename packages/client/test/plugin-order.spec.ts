import { ConnectionType, ServerMessageType } from '@nmtjs/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type {
  ClientPlugin,
  ClientPluginInstance,
} from '../src/plugins/types.ts'
import type { ClientTransportStartParams } from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'

const createMockBidirectionalTransport = () => {
  let connectHandler: ClientTransportStartParams | null = null
  let connectResolve: (() => void) | null = null

  const transport = {
    type: ConnectionType.Bidirectional as const,
    connect: vi.fn(async (params: ClientTransportStartParams) => {
      connectHandler = params
      return new Promise<void>((resolve) => {
        connectResolve = resolve
      })
    }),
    disconnect: vi.fn(async () => {
      connectHandler?.onDisconnect?.('client')
    }),
    send: vi.fn(async () => {}),
  }

  return {
    transport,
    factory: () => transport,
    simulateConnect: () => {
      if (connectResolve) {
        connectResolve()
        connectHandler?.onConnect?.()
      }
    },
    simulateDisconnect: (reason: 'server' | 'client' = 'server') => {
      connectHandler?.onDisconnect?.(reason)
    },
  }
}

const mockFormat = {
  contentType: 'test',
  encode: vi.fn((data) => new Uint8Array()),
  decode: vi.fn((data) => ({})),
  encodeRPC: vi.fn((data) => new Uint8Array()),
  decodeRPC: vi.fn((data) => ({})),
}

const baseOptions: BaseClientOptions = {
  contract: {} as any,
  protocol: 1,
  format: mockFormat as any,
}

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

    const { factory, simulateConnect, simulateDisconnect } =
      createMockBidirectionalTransport()

    const client = new StaticClient(
      {
        ...baseOptions,
        plugins: [mkPlugin('a'), mkPlugin('b'), mkPlugin('c')],
      },
      factory,
      {},
    )

    expect(events.join('|')).toBe('init:a|init:b|init:c')

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    expect(events.join('|')).toBe(
      'init:a|init:b|init:c|connect:a|connect:b|connect:c',
    )

    simulateDisconnect('server')
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

    const { factory, simulateConnect } = createMockBidirectionalTransport()

    const client = new StaticClient(
      {
        ...baseOptions,
        plugins: [mkPlugin('a'), mkPlugin('b'), mkPlugin('c')],
      },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    ;(client as any).protocol.decodeMessage = () => ({
      type: ServerMessageType.Pong,
      nonce: 1,
    })

    await (client as any).onMessage(new Uint8Array())

    expect(events.join('|')).toBe('message:a|message:b|message:c')
  })
})
