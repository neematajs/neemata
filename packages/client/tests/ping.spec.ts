import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { ConnectionType, ServerMessageType } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { EventEmitter } from '../src/events.ts'
import { createPingLayer } from '../src/layers/ping.ts'

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

class MockCore extends EventEmitter<{
  message: [message: unknown, raw: ArrayBufferView]
  connected: []
  disconnected: [reason: string]
  state_changed: [state: string, previous: string]
  pong: [nonce: number]
}> {
  constructor(
    readonly transportType: ConnectionType = ConnectionType.Bidirectional,
    readonly state: 'connected' | 'disconnected' = 'connected',
    readonly messageContext: object | null = {},
  ) {
    super()
  }

  readonly format: BaseClientFormat = {
    contentType: 'application/json',
    encode: vi.fn(encodeJson),
    decode: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
    encodeRPC: vi.fn(encodeJson),
    decodeRPC: vi.fn((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
  } as BaseClientFormat

  readonly protocol = {
    encodeMessage: vi.fn((_context, type) => new Uint8Array([type])),
  } as any

  readonly send = vi.fn(async () => {})
}

describe('PingLayer', () => {
  it('sends a ping and resolves when the matching pong arrives', async () => {
    const core = new MockCore()
    const layer = createPingLayer(core as any)
    const pongListener = vi.fn()
    core.on('pong', pongListener)

    const pingPromise = layer.ping(100)

    expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
      core.messageContext,
      expect.any(Number),
      { nonce: 0 },
    )
    expect(core.send).toHaveBeenCalledTimes(1)

    core.emit(
      'message',
      { type: ServerMessageType.Pong, nonce: 0 },
      new Uint8Array([1]),
    )

    await expect(pingPromise).resolves.toBeUndefined()
    expect(pongListener).toHaveBeenCalledWith(0)
  })

  it('responds to server ping messages with pong', async () => {
    const core = new MockCore()
    createPingLayer(core as any)

    core.emit(
      'message',
      { type: ServerMessageType.Ping, nonce: 42 },
      new Uint8Array([1]),
    )
    await Promise.resolve()

    expect(core.protocol.encodeMessage).toHaveBeenCalledWith(
      core.messageContext,
      expect.any(Number),
      { nonce: 42 },
    )
    expect(core.send).toHaveBeenCalledTimes(1)
  })

  it('rejects ping attempts when the client is not connected', async () => {
    const disconnectedCore = new MockCore(
      ConnectionType.Bidirectional,
      'disconnected',
      null,
    )
    const layer = createPingLayer(disconnectedCore as any)

    await expect(layer.ping(100)).rejects.toThrow('Client is not connected')
  })

  it('rejects pending pings when the core disconnects', async () => {
    const core = new MockCore()
    const layer = createPingLayer(core as any)

    const pingPromise = layer.ping(1000)
    core.emit('disconnected', 'server')

    await expect(pingPromise).rejects.toThrow('Heartbeat stopped')
  })
})
