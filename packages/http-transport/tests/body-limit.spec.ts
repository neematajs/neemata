import { describe, expect, it } from 'vitest'

import { HttpTransport } from '../src/runtimes/node.ts'
import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('request body size limit', () => {
  it('rejects oversized body with 413 without buffering the whole payload', async () => {
    const { params, onRpc } = createTestParams()
    const server = await createTestServer(
      { maxRequestBodySize: 128 * 1024 },
      params,
    )

    const chunk = new Uint8Array(64 * 1024).fill(97) // 'a'
    const totalChunks = 100
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls > totalChunks) controller.close()
        else controller.enqueue(chunk)
      },
    })

    const response = await server.httpHandler(
      createTestRequest(JSON_HEADERS),
      body,
      new AbortController().signal,
    )

    expect(response.status).toBe(413)
    expect(onRpc).not.toHaveBeenCalled()
    // Buffering must stop as soon as the cap is exceeded (3 chunks), not
    // consume the whole stream; a few extra pulls are read-ahead buffering
    expect(pulls).toBeLessThan(20)
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
})
