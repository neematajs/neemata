import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import { NeemataHttpHandler } from '../../../src/neemata/http/server.ts'
import { createTestCodecs } from './_helpers/test-utils.ts'

const createServer = (result: unknown) => {
  const params = {
    onConnect: async () => ({
      [Symbol.asyncDispose]: async () => {},
    }),
    onDisconnect: async () => {},
    resolve: async () => ({ meta: new Map() }),
    onRpc: async () => result,
  } as any
  return new NeemataHttpHandler(params, createTestCodecs(), { path: '/' })
}

const handle = (server: NeemataHttpHandler) =>
  server.handle(new Request('http://localhost/procedure', { method: 'POST' }))

describe('NeemataHttpHandler blob responses', () => {
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
