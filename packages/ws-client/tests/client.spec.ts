import { ProtocolVersion } from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WsTransportClient } from '../src/index.ts'

class TestFormat extends BaseClientFormat {
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return new TextEncoder().encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data)
  }

  decode(buffer: ArrayBufferView): unknown {
    return JSON.parse(new TextDecoder().decode(buffer))
  }

  decodeRPC(buffer: ArrayBufferView): unknown {
    return this.decode(buffer)
  }
}

type Listener = (event: Event & Record<string, unknown>) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: URL
  binaryType = 'blob'
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.emit('close', { code, reason })
  })

  #listeners = new Map<string, Set<Listener>>()

  constructor(url: string | URL) {
    this.url = url instanceof URL ? url : new URL(url)
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  emit(type: string, init: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type), init)
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

afterEach(() => {
  FakeWebSocket.instances.length = 0
  vi.clearAllMocks()
})

describe('WsTransportClient', () => {
  it('connects, forwards messages, and reports server disconnects', async () => {
    const transport = new WsTransportClient(
      new TestFormat(),
      ProtocolVersion.v1,
      { url: 'http://localhost:4000', WebSocket: FakeWebSocket as any },
    )

    const onConnect = vi.fn()
    const onMessage = vi.fn()
    const onDisconnect = vi.fn()

    const connectPromise = transport.connect({
      application: 'demo',
      auth: 'Bearer t',
      onConnect,
      onMessage,
      onDisconnect,
    })

    const socket = FakeWebSocket.instances.at(-1)
    expect(socket).toBeDefined()
    expect(socket?.url.toString()).toContain('/demo')
    expect(socket?.url.searchParams.get('auth')).toBe('Bearer t')

    socket!.emit('open')
    await connectPromise

    expect(onConnect).toHaveBeenCalledTimes(1)

    const payload = new Uint8Array([1, 2, 3]).buffer
    socket!.emit('message', { data: payload })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(Array.from(onMessage.mock.calls[0][0] as Uint8Array)).toEqual([
      1, 2, 3,
    ])

    socket!.emit('close', { reason: 'server_shutdown' })
    expect(onDisconnect).toHaveBeenCalledWith('server')
  })

  it('closes with client reason and respects aborted sends', async () => {
    const transport = new WsTransportClient(
      new TestFormat(),
      ProtocolVersion.v1,
      { url: 'http://localhost:4000', WebSocket: FakeWebSocket as any },
    )

    const onDisconnect = vi.fn()

    const connectPromise = transport.connect({
      onConnect: vi.fn(),
      onMessage: vi.fn(),
      onDisconnect,
    })

    const socket = FakeWebSocket.instances.at(-1)!
    socket.emit('open')
    await connectPromise

    const aborted = new AbortController()
    aborted.abort('stop')

    await transport.send(new Uint8Array([9]), { signal: aborted.signal })
    expect(socket.send).not.toHaveBeenCalled()

    await transport.disconnect()

    expect(socket.close).toHaveBeenCalledWith(1000, 'client')
    expect(onDisconnect).toHaveBeenCalledWith('client')
  })
})
