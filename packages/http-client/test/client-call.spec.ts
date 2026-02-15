import { ProtocolVersion } from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../../client/src/clients/static.ts'
import { loggingPlugin } from '../../client/src/plugins/logging.ts'
import { HttpTransportFactory } from '../src/index.ts'

class TestJsonFormat extends BaseClientFormat {
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return new TextEncoder().encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown, _context: any): ArrayBufferView {
    return this.encode(data)
  }

  decode(buffer: ArrayBufferView): unknown {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      ),
    )
  }

  decodeRPC(buffer: ArrayBufferView, _context: any): unknown {
    return this.decode(buffer)
  }
}

const toUint8 = (buffer: ArrayBufferView) =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

describe('HttpTransportClient + StaticClient', () => {
  it('returns undefined for empty unidirectional RPC response body', async () => {
    const format = new TestJsonFormat()
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array(0) as any, {
          status: 200,
          headers: { 'content-type': format.contentType },
        }),
      )

    const client = new StaticClient(
      { contract: {} as any, protocol: ProtocolVersion.v1, format },
      HttpTransportFactory,
      { url: 'http://localhost:4000', fetch: fetchSpy },
    )

    await expect((client.call as any).empty(undefined)).resolves.toBeUndefined()
  })

  it('returns decoded object for unidirectional RPC call', async () => {
    const format = new TestJsonFormat()
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const requestBody = init?.body as ArrayBufferView
        const payload = format.decode(requestBody)
        const responseBody = format.encode({ ok: true, echoed: payload })
        return new Response(toUint8(responseBody) as any, {
          status: 200,
          headers: { 'content-type': format.contentType },
        })
      })

    const client = new StaticClient(
      { contract: {} as any, protocol: ProtocolVersion.v1, format },
      HttpTransportFactory,
      { url: 'http://localhost:4000', fetch: fetchSpy },
    )

    const payload = { userId: 'u1' }
    const result = await (client.call as any).ping(payload)

    expect(result).toEqual({ ok: true, echoed: payload })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('emits decoded rpc_response body in logging plugin', async () => {
    const emitted: unknown[] = []
    const format = new TestJsonFormat()
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        const requestBody = init?.body as ArrayBufferView
        const payload = format.decode(requestBody)
        const responseBody = format.encode({ ok: true, echoed: payload })
        return new Response(toUint8(responseBody) as any, {
          status: 200,
          headers: { 'content-type': format.contentType },
        })
      })

    const client = new StaticClient(
      {
        contract: {} as any,
        protocol: ProtocolVersion.v1,
        format,
        plugins: [
          loggingPlugin({
            includeBodies: true,
            onEvent: (event) => {
              emitted.push(event)
            },
          }),
        ],
      },
      HttpTransportFactory,
      { url: 'http://localhost:4000', fetch: fetchSpy },
    )

    const payload = { token: 'abc' }
    await (client.call as any).account(payload)

    const rpcResponse = emitted.find(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        (event as { kind: string }).kind === 'rpc_response',
    ) as { body: unknown } | undefined

    expect(rpcResponse).toBeDefined()
    expect(rpcResponse?.body).toEqual({ ok: true, echoed: payload })
    expect(ArrayBuffer.isView(rpcResponse?.body)).toBe(false)
  })
})
