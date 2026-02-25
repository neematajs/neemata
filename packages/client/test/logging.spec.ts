import { c } from '@nmtjs/contract'
import { ConnectionType, ServerMessageType } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../src/core.ts'
import type { ClientLogEvent } from '../src/plugins/logging.ts'
import type {
  ClientTransportFactory,
  ClientTransportStartParams,
} from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'
import { loggingPlugin } from '../src/plugins/logging.ts'

const testContract = c.router({
  routes: {
    users: c.router({
      routes: {
        profile: c.procedure({
          input: t.object({ userId: t.string() }),
          output: t.object({ ok: t.boolean(), echoed: t.any() }),
        }),
      },
    }),
    account: c.router({
      routes: {
        get: c.procedure({
          input: t.object({ token: t.string() }),
          output: t.object({ ok: t.boolean(), echoed: t.any() }),
        }),
      },
    }),
    health: c.router({
      routes: {
        check: c.procedure({
          input: t.object({}),
          output: t.object({ ok: t.boolean(), echoed: t.any() }),
        }),
      },
    }),
  },
})

class TestStaticClient<
  Transport extends ClientTransportFactory<any, any>,
> extends StaticClient<Transport, typeof testContract> {
  emitTestEvent(event: ClientLogEvent) {
    this.emitClientEvent(event)
  }

  async emitDecodedServerMessage(message: unknown, raw: ArrayBufferView) {
    const protocol = this.protocol
    const originalDecodeMessage = protocol.decodeMessage
    protocol.decodeMessage = (() => message) as typeof protocol.decodeMessage

    try {
      await this.onMessage(raw)
    } finally {
      protocol.decodeMessage = originalDecodeMessage
    }
  }
}

const createMockUnidirectionalTransport = () => {
  const transport = {
    type: ConnectionType.Unidirectional as const,
    call: vi.fn(async (context, input, _options) => ({
      type: 'rpc' as const,
      result: context.format.encode({ ok: true, echoed: input.payload }),
    })),
  }

  return { transport, factory: () => transport }
}

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
  }
}

const mockFormat = {
  contentType: 'test',
  encode: vi.fn((data) => new TextEncoder().encode(JSON.stringify(data))),
  decode: vi.fn((data) =>
    JSON.parse(new TextDecoder().decode(data as ArrayBufferView)),
  ),
  encodeRPC: vi.fn((data) => new TextEncoder().encode(JSON.stringify(data))),
  decodeRPC: vi.fn((data) =>
    JSON.parse(new TextDecoder().decode(data as ArrayBufferView)),
  ),
}

const baseOptions: BaseClientOptions<typeof testContract> = {
  contract: testContract,
  protocol: 1,
  format: mockFormat as any,
}

describe('loggingPlugin', () => {
  it('emits rpc_request and rpc_response for unidirectional rpc call', async () => {
    const emitted: ClientLogEvent[] = []

    const { factory } = createMockUnidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    await client.call.users.profile({ userId: 'u1' })

    const kinds = emitted
      .filter(
        (event) =>
          event.kind === 'rpc_request' || event.kind === 'rpc_response',
      )
      .map((event) => event.kind)

    expect(kinds).toEqual(['rpc_request', 'rpc_response'])
  })

  it('defaults includeBodies to false for request/response/server_message events', async () => {
    const emitted: ClientLogEvent[] = []

    const { factory } = createMockUnidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    await client.call.account.get({ token: 'secret' })
    client.emitTestEvent({
      kind: 'server_message',
      timestamp: Date.now(),
      messageType: 1,
      rawByteLength: 10,
      body: { private: true },
    })

    const requestEvent = emitted.find((event) => event.kind === 'rpc_request')
    const responseEvent = emitted.find((event) => event.kind === 'rpc_response')
    const serverMessageEvent = emitted.find(
      (event) => event.kind === 'server_message',
    )

    expect(requestEvent).toBeDefined()
    expect(responseEvent).toBeDefined()
    expect(serverMessageEvent).toBeDefined()

    expect('body' in requestEvent!).toBe(false)
    expect('body' in responseEvent!).toBe(false)
    expect('body' in serverMessageEvent!).toBe(false)
  })

  it('preserves event body when includeBodies is true', async () => {
    const emitted: ClientLogEvent[] = []

    const payload = { token: 'keep-me' }
    const { factory } = createMockUnidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    await client.call.account.get(payload)
    client.emitTestEvent({
      kind: 'server_message',
      timestamp: Date.now(),
      messageType: 2,
      rawByteLength: 3,
      body: { nested: true },
    })

    const requestEvent = emitted.find(
      (event) => event.kind === 'rpc_request',
    ) as Extract<ClientLogEvent, { kind: 'rpc_request' }>
    const responseEvent = emitted.find(
      (event) => event.kind === 'rpc_response',
    ) as Extract<ClientLogEvent, { kind: 'rpc_response' }>
    const serverMessageEvent = emitted.find(
      (event) => event.kind === 'server_message',
    ) as Extract<ClientLogEvent, { kind: 'server_message' }>

    expect(requestEvent.body).toEqual(payload)
    expect(responseEvent.body).toEqual({ ok: true, echoed: payload })
    expect(serverMessageEvent.body).toEqual({ nested: true })
  })

  it('does not break rpc call when sink throws synchronously or asynchronously', async () => {
    const onSinkError = vi.fn()

    const onEvent = vi
      .fn<(event: ClientLogEvent) => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('sync sink error')
      })
      .mockImplementationOnce(async () => {
        throw new Error('async sink error')
      })

    const { factory } = createMockUnidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [loggingPlugin({ includeBodies: true, onEvent, onSinkError })],
      },
      factory,
      {},
    )

    const result = await client.call.health.check({})

    await Promise.resolve()

    expect(result).toEqual({ ok: true, echoed: {} })
    expect(onSinkError).toHaveBeenCalledTimes(2)
  })

  it('applies mapEvent and skips sink when it returns null', async () => {
    const emitted: ClientLogEvent[] = []

    const { factory } = createMockUnidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            mapEvent: (event) => (event.kind === 'rpc_request' ? null : event),
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    await client.call.health.check({})

    expect(emitted.some((event) => event.kind === 'rpc_request')).toBe(false)
    expect(emitted.some((event) => event.kind === 'rpc_response')).toBe(true)
  })

  it('emits server_message through onClientEvent hook', async () => {
    const emitted: ClientLogEvent[] = []

    const { factory, simulateConnect } = createMockBidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    const decodedMessage = { type: 4, nonce: 1, payload: { hello: 'world' } }

    await client.emitDecodedServerMessage(
      decodedMessage,
      new Uint8Array([1, 2, 3]),
    )

    const serverMessageEvent = emitted.find(
      (event) => event.kind === 'server_message',
    ) as Extract<ClientLogEvent, { kind: 'server_message' }>

    expect(serverMessageEvent).toBeDefined()
    expect(serverMessageEvent.rawByteLength).toBe(3)
    expect(serverMessageEvent.body).toEqual({
      type: 4,
      nonce: 1,
      payload: { hello: 'world' },
    })
  })

  it('emits stream_event for incoming server stream chunk', async () => {
    const emitted: ClientLogEvent[] = []

    const { factory, simulateConnect } = createMockBidirectionalTransport()
    const client = new TestStaticClient(
      {
        ...baseOptions,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      factory,
      {},
    )

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    await client.emitDecodedServerMessage(
      {
        type: ServerMessageType.ServerStreamPush,
        streamId: 7,
        chunk: new Uint8Array([1, 2, 3]),
      },
      new Uint8Array([1, 2, 3, 4]),
    )

    const streamEvent = emitted.find(
      (event) => event.kind === 'stream_event',
    ) as Extract<ClientLogEvent, { kind: 'stream_event' }>

    expect(streamEvent).toBeDefined()
    expect(streamEvent.direction).toBe('incoming')
    expect(streamEvent.streamType).toBe('server_blob')
    expect(streamEvent.action).toBe('push')
    expect(streamEvent.streamId).toBe(7)
    expect(streamEvent.byteLength).toBe(3)
  })
})
