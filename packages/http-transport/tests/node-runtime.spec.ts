import { setTimeout as delay } from 'node:timers/promises'

import { BaseServerFormat, ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { HttpTransportServerRequest } from '../src/types.ts'
import { HttpTransport } from '../src/runtimes/node.ts'

class TestJsonFormat extends BaseServerFormat {
  accept = ['application/json']
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return new TextEncoder().encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data)
  }

  encodeBlob(): unknown {
    return null
  }

  decode(buffer: ArrayBufferView): any {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      ),
    )
  }

  decodeRPC(buffer: ArrayBufferView): any {
    return this.decode(buffer)
  }
}

async function startServer(onRpc?: (...args: any[]) => Promise<unknown>) {
  const format = new TestJsonFormat()
  const connection = {
    encoder: format,
    decoder: format,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
  const requests: HttpTransportServerRequest[] = []
  const params = {
    formats: new ProtocolFormats([format]),
    onConnect: vi.fn(async (options: { data: unknown }) => {
      requests.push(options.data as HttpTransportServerRequest)
      return connection
    }),
    resolve: async () => ({ meta: { get: () => ['get', 'post'] } }),
    onRpc: onRpc ?? (async () => ({ ok: true })),
    onDisconnect: async () => {},
    onMessage: async () => {},
  }

  const worker = await HttpTransport.factory({
    listen: { port: 0, hostname: '127.0.0.1' },
  })
  const url = await worker.start(params as any)

  return {
    url,
    requests,
    stop: () => worker.stop(params as any),
  }
}

describe('node runtime adapter', () => {
  describe('x-forwarded-proto', () => {
    it('uses http when the header says http', async () => {
      const { url, requests, stop } = await startServer()
      try {
        const response = await fetch(`${url}/test`, {
          headers: { 'x-forwarded-proto': 'http' },
        })
        expect(response.status).toBe(200)
        expect(requests[0]?.url.protocol).toBe('http:')
      } finally {
        await stop()
      }
    })

    it('uses https when the header says https', async () => {
      const { url, requests, stop } = await startServer()
      try {
        const response = await fetch(`${url}/test`, {
          headers: { 'x-forwarded-proto': 'https' },
        })
        expect(response.status).toBe(200)
        expect(requests[0]?.url.protocol).toBe('https:')
      } finally {
        await stop()
      }
    })

    it('falls back to the listener protocol without the header', async () => {
      const { url, requests, stop } = await startServer()
      try {
        const response = await fetch(`${url}/test`)
        expect(response.status).toBe(200)
        expect(requests[0]?.url.protocol).toBe('http:')
      } finally {
        await stop()
      }
    })
  })

  describe('chunked stream backpressure', () => {
    it('pauses reading the source stream when the client does not consume', async () => {
      const chunkSize = 256 * 1024
      const totalChunks = 100
      const chunk = new Uint8Array(chunkSize).fill(97)
      let pulled = 0

      const { url, stop } = await startServer(async () => {
        // no content-length header -> exercises the chunked write path
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            controller.enqueue(chunk)
            if (pulled >= totalChunks) controller.close()
          },
        })
        return new Response(stream)
      })

      try {
        const response = await fetch(`${url}/test`)
        expect(response.status).toBe(200)

        // give the server time to push as much as buffers allow while the
        // client is not reading the body yet
        await delay(500)
        expect(pulled).toBeLessThan(totalChunks)

        const body = new Uint8Array(await response.arrayBuffer())
        expect(pulled).toBe(totalChunks)
        expect(body.byteLength).toBe(chunkSize * totalChunks)
      } finally {
        await stop()
      }
    })
  })
})
