import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { neemataHttp } from '@nmtjs/transports/neemata/http'
import { describe, expect, it, vi } from 'vitest'

import {
  createTestCodecs,
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

const Server = createServerTransport({
  host: createServerHost,
  handlers: { http: neemataHttp({ codecs: createTestCodecs() }) },
})

const JSON_HEADERS = { 'content-type': 'application/json' }
const BLOB_HEADERS = {
  'content-type': 'application/octet-stream',
  'x-neemata-blob': 'true',
}

// Mimics a real procedure consuming an uploaded blob stream
const consumingRpc = () =>
  vi.fn(async (_connection: any, rpc: any) => {
    if (rpc.payload && typeof rpc.payload.toArray === 'function') {
      await rpc.payload.toArray()
    }
    return { ok: true }
  })

function createCountingBody(chunkSize: number, totalChunks: number) {
  const chunk = new Uint8Array(chunkSize).fill(97) // 'a'
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls > totalChunks) controller.close()
      else controller.enqueue(chunk)
    },
  })
  return { body, getPulls: () => pulls }
}

describe('request body size limit', () => {
  it('rejects oversized body with 413 without buffering the whole payload', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer(
      { maxRequestBodySize: 128 * 1024 },
      params,
    )

    const { body, getPulls } = createCountingBody(64 * 1024, 100)

    const response = await server.handle(createTestRequest(JSON_HEADERS, body))

    expect(response.status).toBe(413)
    expect(onRpc).not.toHaveBeenCalled()
    // Buffering must stop as soon as the cap is exceeded (3 chunks), not
    // consume the whole stream; a few extra pulls are read-ahead buffering
    expect(getPulls()).toBeLessThan(20)
  })

  it('rejects oversized blob body with 413 and keeps the server alive', async () => {
    const onRpc = consumingRpc()
    const { params } = createTestParams(onRpc)
    const server = await createTestServer(
      { maxRequestBodySize: 128 * 1024 },
      params,
    )

    // No content-length: forces enforcement while streaming, not up-front
    const { body, getPulls } = createCountingBody(64 * 1024, 100)
    const response = await server.handle(createTestRequest(BLOB_HEADERS, body))

    expect(response.status).toBe(413)
    expect(getPulls()).toBeLessThan(20)

    // Same server instance must still serve subsequent requests
    const ok = await server.handle(
      createTestRequest(
        JSON_HEADERS,
        new Response(JSON.stringify({ hello: 'world' })).body!,
      ),
    )
    expect(ok.status).toBe(200)
  })

  it('rejects oversized undecodable body with 413', async () => {
    const onRpc = consumingRpc()
    const { params } = createTestParams(onRpc)
    const server = await createTestServer(
      { maxRequestBodySize: 128 * 1024 },
      params,
    )

    const { body } = createCountingBody(64 * 1024, 100)
    const response = await server.handle(
      createTestRequest({ 'content-type': 'text/unsupported' }, body),
    )

    expect(response.status).toBe(413)
  })

  it('rejects blob body with declared content-length over the limit up-front', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer({ maxRequestBodySize: 1024 }, params)

    const { body, getPulls } = createCountingBody(64 * 1024, 1)
    const response = await server.handle(
      createTestRequest({ ...BLOB_HEADERS, 'content-length': '65536' }, body),
    )

    expect(response.status).toBe(413)
    expect(onRpc).not.toHaveBeenCalled()
    // A single pull is the stream pre-filling its own queue, not the handler
    expect(getPulls()).toBeLessThanOrEqual(1)
  })

  it('accepts body within the limit', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer(
      { maxRequestBodySize: 128 * 1024 },
      params,
    )

    const payload = JSON.stringify({ hello: 'world' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })

    const response = await server.handle(createTestRequest(JSON_HEADERS, body))

    expect(response.status).toBe(200)
    expect(onRpc).toHaveBeenCalledTimes(1)
    expect(onRpc.mock.calls[0][1]).toMatchObject({
      payload: { hello: 'world' },
    })
  })

  it('inherits the host limit when the handler limit is unset', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer({}, params, 1024)
    const { body } = createCountingBody(1024, 2)

    const response = await server.handle(createTestRequest(JSON_HEADERS, body))

    expect(response.status).toBe(413)
    expect(onRpc).not.toHaveBeenCalled()

    const accepted = await server.handle(
      createTestRequest(JSON_HEADERS, new Response('{}').body!),
    )
    expect(accepted.status).toBe(200)
    expect(onRpc).toHaveBeenCalledOnce()
  })

  it('rejects a handler limit above the host limit at mount time', () => {
    const { params } = createTestParams()
    // A stub host is enough: the check must fire before anything mounts
    const host = {
      maxRequestBodySize: 1024,
      mountFetchHandler: () => () => {},
    } as any

    expect(() =>
      neemataHttp({ codecs: createTestCodecs() }).mount(
        { host, gateway: params as any },
        { path: '/', maxRequestBodySize: 2048 },
      ),
    ).toThrow(/exceeds the host limit/)
  })

  it('rejects a handler limit above the host limit on transport start', async () => {
    const { params } = createTestParams()
    const worker = await Server.factory({
      listen: { port: 0 },
      maxRequestBodySize: 1024,
      handlers: {
        http: {
          path: '/',
          maxRequestBodySize: 2048,
        },
      },
    })

    await expect(worker.start(params as any)).rejects.toThrow(
      /exceeds the host limit/,
    )
  })
})

describe('request body size limit (node runtime)', () => {
  it('caps request bodies on the node adapter', async () => {
    const { params, onRpc } = createTestParams()
    const worker = await Server.factory({
      listen: { port: 0 },
      maxRequestBodySize: 1024,
      handlers: {
        http: {
          path: '/',
          maxRequestBodySize: 1024,
        },
      },
    })
    const url = await worker.start(params as any)

    try {
      const oversized = await fetch(`${url}/testProcedure`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ data: 'x'.repeat(64 * 1024) }),
      })
      expect(oversized.status).toBe(413)
      expect(onRpc).not.toHaveBeenCalled()

      const ok = await fetch(`${url}/testProcedure`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ hello: 'world' }),
      })
      expect(ok.status).toBe(200)
      expect(onRpc).toHaveBeenCalledTimes(1)
    } finally {
      await worker.stop()
    }
  })

  it('caps blob bodies on the node adapter and survives', async () => {
    const onRpc = consumingRpc()
    const { params } = createTestParams(onRpc)
    const worker = await Server.factory({
      listen: { port: 0 },
      maxRequestBodySize: 1024,
      handlers: {
        http: {
          path: '/',
          maxRequestBodySize: 1024,
        },
      },
    })
    const url = await worker.start(params as any)

    try {
      const oversized = await fetch(`${url}/testProcedure`, {
        method: 'POST',
        headers: BLOB_HEADERS,
        body: new Uint8Array(64 * 1024),
      })
      expect(oversized.status).toBe(413)

      const ok = await fetch(`${url}/testProcedure`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ hello: 'world' }),
      })
      expect(ok.status).toBe(200)
    } finally {
      await worker.stop()
    }
  })
})
