import type { ProtocolBlob, ProtocolBlobMetadata } from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  MessageContext,
  ProtocolClientBlobStream,
  ProtocolServerBlobConsumer,
} from '@nmtjs/protocol/client'
import { ConnectionType, kBlobKey, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolServerBlobStream } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

import type { TransportConnectParams } from '../src/transport.ts'
import { ClientCore } from '../src/core.ts'

const format: BaseClientFormat = {
  contentType: 'application/json',
  encode: vi.fn((value) => new TextEncoder().encode(JSON.stringify(value))),
  decode: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
  encodeRPC: vi.fn((value) => new TextEncoder().encode(JSON.stringify(value))),
  decodeRPC: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
} as BaseClientFormat

const createBlobConsumer = (
  metadata: ProtocolBlobMetadata,
): ProtocolServerBlobConsumer => {
  const consumer = (() =>
    new ProtocolServerBlobStream(metadata)) as ProtocolServerBlobConsumer

  Object.defineProperties(consumer, {
    metadata: {
      configurable: false,
      enumerable: true,
      writable: false,
      value: metadata,
    },
    [kBlobKey]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    },
  })

  return consumer
}

const createMessageContext = (): MessageContext => ({
  encoder: format,
  decoder: format,
  transport: { send: vi.fn() },
  streamId: vi.fn(() => 1),
  addClientStream: vi.fn(() => ({}) as unknown as ProtocolClientBlobStream) as (
    blob: ProtocolBlob,
  ) => ProtocolClientBlobStream,
  addServerStream: vi.fn((_, metadata) => createBlobConsumer(metadata)) as (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolServerBlobConsumer,
})

const createBidirectionalTransportDouble = () => {
  let params: TransportConnectParams | null = null
  const resolves: Array<() => void> = []

  const transport = {
    type: ConnectionType.Bidirectional as const,
    connect: vi.fn((nextParams: TransportConnectParams) => {
      params = nextParams
      return new Promise<void>((resolve) => {
        resolves.push(resolve)
      })
    }),
    disconnect: vi.fn(async () => {
      params?.onDisconnect('client')
    }),
    send: vi.fn(async () => {}),
  }

  return {
    transport,
    get params() {
      if (!params) throw new Error('Transport has not connected yet')
      return params
    },
    open() {
      const resolve = resolves.shift()
      if (!resolve) throw new Error('No pending connection to open')
      this.params.onConnect()
      resolve()
    },
    emitMessage(buffer: ArrayBufferView) {
      this.params.onMessage(buffer)
    },
    disconnectFromServer(reason: 'server' | 'client' | string = 'server') {
      this.params.onDisconnect(reason)
    },
  }
}

describe('ClientCore', () => {
  it('connects a bidirectional transport and emits lifecycle state changes', async () => {
    const transport = createBidirectionalTransportDouble()
    const core = new ClientCore(
      { protocol: ProtocolVersion.v1, format, application: 'demo' },
      transport.transport,
    )

    core.auth = 'Bearer test'

    const context = createMessageContext()
    const messageContextFactory = vi.fn(() => context)
    core.setMessageContextFactory(messageContextFactory)

    const states: string[] = []
    core.on('state_changed', (state) => {
      states.push(state)
    })

    const connectPromise = core.connect()

    expect(core.state).toBe('connecting')
    expect(messageContextFactory).toHaveBeenCalledTimes(1)
    expect(transport.transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'Bearer test', application: 'demo' }),
    )

    transport.open()
    await connectPromise

    expect(core.state).toBe('connected')
    expect(core.messageContext).toBe(context)

    await core.disconnect('client')

    expect(core.state).toBe('disconnected')
    expect(core.messageContext).toBeNull()
    expect(states).toEqual([
      'connecting',
      'connected',
      'disconnecting',
      'disconnected',
    ])
  })

  it('falls back to disconnected state when transport disconnect resolves without callback', async () => {
    const transport = createBidirectionalTransportDouble()
    const core = new ClientCore(
      { protocol: ProtocolVersion.v1, format },
      transport.transport,
    )

    core.setMessageContextFactory(() => createMessageContext())

    const states: string[] = []
    core.on('state_changed', (state) => {
      states.push(state)
    })

    const connectPromise = core.connect()
    transport.open()
    await connectPromise

    transport.transport.disconnect.mockImplementationOnce(async () => {})

    await core.disconnect('client')

    expect(core.state).toBe('disconnected')
    expect(core.messageContext).toBeNull()
    expect(states).toEqual([
      'connecting',
      'connected',
      'disconnecting',
      'disconnected',
    ])
  })

  it('decodes incoming transport messages and emits them on the message bus', async () => {
    const transport = createBidirectionalTransportDouble()
    const core = new ClientCore(
      { protocol: ProtocolVersion.v1, format },
      transport.transport,
    )

    const context = createMessageContext()
    core.setMessageContextFactory(() => context)

    const decodedMessage = { type: 999, ok: true }
    const decodeMessage = vi.fn(() => decodedMessage)
    ;(core.protocol as any).decodeMessage = decodeMessage

    const listener = vi.fn()
    core.on('message', listener)

    const connectPromise = core.connect()
    transport.open()
    await connectPromise

    const raw = new Uint8Array([7, 8, 9])
    transport.emitMessage(raw)
    await Promise.resolve()

    expect(decodeMessage).toHaveBeenCalledWith(context, raw)
    expect(listener).toHaveBeenCalledWith(decodedMessage, raw)
  })

  it('reconnects after a server disconnect when reconnect is configured', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)

    try {
      const transport = createBidirectionalTransportDouble()
      const core = new ClientCore(
        { protocol: ProtocolVersion.v1, format },
        transport.transport,
      )

      core.setMessageContextFactory(() => createMessageContext())

      const connectPromise = core.connect()
      transport.open()
      await connectPromise

      core.configureReconnect({ initialTimeout: 10, maxTimeout: 20 })
      transport.disconnectFromServer('server')

      expect(core.state).toBe('disconnected')

      await vi.advanceTimersByTimeAsync(10)

      expect(transport.transport.connect).toHaveBeenCalledTimes(2)
      expect(core.state).toBe('connecting')
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
