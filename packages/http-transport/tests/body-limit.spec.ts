import { describe, expect, it, vi } from 'vitest'

import { HttpTransport } from '../src/runtimes/node.ts'
import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

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

    const response = await server.httpHandler(
      createTestRequest(JSON_HEADERS),
      body,
      new AbortController().signal,
    )

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
    const response = await server.httpHandler(
      createTestRequest(BLOB_HEADERS),
      body,
      new AbortController().signal,
    )

    expect(response.status).toBe(413)
    expect(getPulls()).toBeLessThan(20)

    // Same server instance must still serve subsequent requests
    const ok = await server.httpHandler(
      createTestRequest(JSON_HEADERS),
      new Response(JSON.stringify({ hello: 'world' })).body!,
      new AbortController().signal,
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
    const response = await server.httpHandler(
      createTestRequest({ 'content-type': 'text/unsupported' }),
      body,
      new AbortController().signal,
    )

    expect(response.status).toBe(413)
  })

  it('rejects blob body with declared content-length over the limit up-front', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer({ maxRequestBodySize: 1024 }, params)

    const { body, getPulls } = createCountingBody(64 * 1024, 1)
    const response = await server.httpHandler(
      createTestRequest({ ...BLOB_HEADERS, 'content-length': '65536' }),
      body,
      new AbortController().signal,
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

    const response = await server.httpHandler(
      createTestRequest(JSON_HEADERS),
      body,
      new AbortController().signal,
    )

    expect(response.status).toBe(200)
    expect(onRpc).toHaveBeenCalledTimes(1)
    expect(onRpc.mock.calls[0][1]).toMatchObject({
      payload: { hello: 'world' },
    })
  })
})

describe('request body size limit (node runtime)', () => {
  it('caps request bodies on the node adapter', async () => {
    const { params, onRpc } = createTestParams()
    const worker = await HttpTransport.factory({
      listen: { port: 0 },
      maxRequestBodySize: 1024,
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
      await worker.stop(params as any)
    }
  })

  it('caps blob bodies on the node adapter and survives', async () => {
    const onRpc = consumingRpc()
    const { params } = createTestParams(onRpc)
    const worker = await HttpTransport.factory({
      listen: { port: 0 },
      maxRequestBodySize: 1024,
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
      await worker.stop(params as any)
    }
  })
})
