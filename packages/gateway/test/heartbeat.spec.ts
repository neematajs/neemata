import { Buffer } from 'node:buffer'

import {
  createTestContainer,
  createTestLogger,
  createTestServerFormat,
} from '@nmtjs/_tests'
import { Hooks } from '@nmtjs/core'
import {
  ClientMessageType,
  ConnectionType,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { Gateway } from '../src/gateway.ts'

const encodeUInt32 = (value: number) => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

describe('Gateway heartbeat', () => {
  it('sends server Ping and accepts client Pong', async () => {
    vi.useFakeTimers()

    const logger = createTestLogger()
    const container = createTestContainer({ logger })

    const serverFormat = createTestServerFormat()

    const api: GatewayApi = { call: vi.fn(async () => undefined) }

    let params: any
    const sent: Buffer[] = []

    const transport = {
      start: vi.fn(async (_params) => {
        params = _params
        return 'test://'
      }),
      stop: vi.fn(async () => {}),
      send: vi.fn((connectionId: string, buffer: ArrayBufferView) => {
        sent.push(Buffer.from(buffer as Uint8Array))
        return true
      }),
      close: vi.fn((_connectionId: string) => {}),
    }

    const gateway = new Gateway({
      logger,
      container,
      hooks: new Hooks(),
      formats: new ProtocolFormats([serverFormat]),
      transports: { test: { transport } },
      api,
      heartbeat: { interval: 1000, timeout: 500 },
    })

    await gateway.start()

    const connection = await params.onConnect({
      type: ConnectionType.Bidirectional,
      protocolVersion: ProtocolVersion.v1,
      accept: serverFormat.contentType,
      contentType: serverFormat.contentType,
      data: {},
    })

    // First ping after 1s
    await vi.advanceTimersByTimeAsync(1000)

    expect(sent.length).toBe(1)
    expect(sent[0][0]).toBe(ServerMessageType.Ping)

    const nonce = sent[0].readUInt32LE(1)

    // Reply with Pong
    const pong = Buffer.concat([
      Buffer.from([ClientMessageType.Pong]),
      encodeUInt32(nonce),
    ])

    await params.onMessage({ connectionId: connection.id, data: pong })

    // No close should happen
    expect(transport.close).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('closes connection if Pong is not received', async () => {
    vi.useFakeTimers()

    const logger = createTestLogger()
    const container = createTestContainer({ logger })

    const serverFormat = createTestServerFormat()

    const api: GatewayApi = { call: vi.fn(async () => undefined) }

    let params: any

    const transport = {
      start: vi.fn(async (_params) => {
        params = _params
        return 'test://'
      }),
      stop: vi.fn(async () => {}),
      send: vi.fn((_connectionId: string, _buffer: ArrayBufferView) => true),
      close: vi.fn((_connectionId: string) => {}),
    }

    const gateway = new Gateway({
      logger,
      container,
      hooks: new Hooks(),
      formats: new ProtocolFormats([serverFormat]),
      transports: { test: { transport } },
      api,
      heartbeat: { interval: 1000, timeout: 500 },
    })

    await gateway.start()

    const connection = await params.onConnect({
      type: ConnectionType.Bidirectional,
      protocolVersion: ProtocolVersion.v1,
      accept: serverFormat.contentType,
      contentType: serverFormat.contentType,
      data: {},
    })

    // Send ping
    await vi.advanceTimersByTimeAsync(1000)

    // Wait beyond timeout without pong
    await vi.advanceTimersByTimeAsync(500)

    expect(transport.close).toHaveBeenCalledWith(connection.id, {
      code: 1001,
      reason: 'heartbeat_timeout',
    })

    vi.useRealTimers()
  })
})
