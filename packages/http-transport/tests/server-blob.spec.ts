import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import { HttpTransportServer } from '../src/server.ts'

const createServer = (result: unknown) => {
  const server = new HttpTransportServer(
    () => ({ start: async () => {}, stop: async () => {} }) as any,
    { listen: { port: 0 } },
  )

  server.params = {
    formats: { supportsDecoder: () => false },
    onConnect: async () => ({
      encoder: { contentType: 'application/json' },
      decoder: {},
      [Symbol.asyncDispose]: async () => {},
    }),
    onDisconnect: async () => {},
    onMessage: async () => {},
    resolve: async () => ({ meta: new Map() }),
    onRpc: async () => result,
  } as any

  return server
}

const handle = (server: HttpTransportServer) =>
  server.httpHandler(
    {
      url: new URL('http://localhost/procedure'),
      method: 'POST',
      headers: new Headers(),
    },
    null,
    new AbortController().signal,
  )

describe('HttpTransportServer blob responses', () => {
  it('sends Content-Length: 0 for a zero-byte blob', async () => {
    const response = await handle(createServer(ProtocolBlob.from(new Blob([]))))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Neemata-Blob')).toBe('true')
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(0)
  })

  it('sends the blob size as Content-Length', async () => {
    const response = await handle(createServer(ProtocolBlob.from('hello')))

    expect(response.headers.get('Content-Length')).toBe('5')
    expect(await response.text()).toBe('hello')
  })

  it('omits Content-Length when the blob size is unknown', async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
    const response = await handle(createServer(ProtocolBlob.from(source)))

    expect(response.headers.get('X-Neemata-Blob')).toBe('true')
    expect(response.headers.get('Content-Length')).toBeNull()
  })
})
