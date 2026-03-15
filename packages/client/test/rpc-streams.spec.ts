import { createFuture } from '@nmtjs/common'
import { c } from '@nmtjs/contract'
import { ConnectionType, ServerMessageType } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions, ProtocolClientCall } from '../src/core.ts'
import type {
  ClientTransportFactory,
  ClientTransportStartParams,
} from '../src/transport.ts'
import { StaticClient } from '../src/clients/static.ts'

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
  },
})

class TestStaticClient<
  Transport extends ClientTransportFactory<any, any>,
> extends StaticClient<Transport, typeof testContract> {
  setPendingCall(callId: number, procedure: string) {
    const call = createFuture() as ProtocolClientCall
    call.procedure = procedure
    ;(this.calls as Map<number, ProtocolClientCall>).set(callId, call)
    return call
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

describe('RPC Streams', () => {
  it('does not send pull messages when consuming bidirectional RPC streams', async () => {
    const { factory, simulateConnect, transport } =
      createMockBidirectionalTransport()
    const client = new TestStaticClient(baseOptions, factory, {})

    const connectPromise = client.connect()
    simulateConnect()
    await connectPromise

    const call = client.setPendingCall(1, 'users.profile')

    await client.emitDecodedServerMessage(
      { type: ServerMessageType.RpcStreamResponse, callId: 1 },
      new Uint8Array([1]),
    )

    const stream = await call.promise
    const iterator = stream[Symbol.asyncIterator]()
    const firstChunkPromise = iterator.next()

    await Promise.resolve()
    expect(transport.send).not.toHaveBeenCalled()

    await client.emitDecodedServerMessage(
      {
        type: ServerMessageType.RpcStreamChunk,
        callId: 1,
        chunk: mockFormat.encode({ ok: true, echoed: { userId: '1' } }),
      },
      new Uint8Array([2]),
    )

    await expect(firstChunkPromise).resolves.toEqual({
      done: false,
      value: { ok: true, echoed: { userId: '1' } },
    })

    await client.emitDecodedServerMessage(
      { type: ServerMessageType.RpcStreamEnd, callId: 1 },
      new Uint8Array([3]),
    )

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect(transport.send).not.toHaveBeenCalled()
  })
})
