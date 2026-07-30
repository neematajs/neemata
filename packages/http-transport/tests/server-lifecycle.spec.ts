import { ProtocolBlob } from '@nmtjs/protocol'
import {
  UnsupportedAcceptTypeError,
  UnsupportedContentTypeError,
} from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function createLifecycleServer(onRpc: any) {
  const { params, connection } = createTestParams(vi.fn(onRpc) as any)
  const dispose = vi.fn(async () => {})
  ;(connection as any)[Symbol.asyncDispose] = dispose
  const server = await createTestServer({}, params)
  return { server, params, dispose }
}

describe('connection lifetime vs response body lifetime', () => {
  describe('buffered responses', () => {
    it('disposes the connection before the handler returns', async () => {
      const { server, dispose } = await createLifecycleServer(async () => ({
        ok: true,
      }))

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(200)
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('disposes the connection on error responses', async () => {
      const { server, dispose } = await createLifecycleServer(async () => {
        throw new Error('boom')
      })

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(500)
      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe('blob download', () => {
    it('keeps the connection alive until the body is fully consumed', async () => {
      const { server, dispose } = await createLifecycleServer(async () =>
        ProtocolBlob.from('hello world'),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      // the body streams after the handler returned: the connection scope
      // (abort signal + connection-scoped DI) must still be alive
      expect(dispose).not.toHaveBeenCalled()

      expect(await response.text()).toBe('hello world')
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('disposes the connection when the client cancels the body mid-stream', async () => {
      let sourceCancelled = false
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(16))
        },
        cancel() {
          sourceCancelled = true
        },
      })
      const { server, dispose } = await createLifecycleServer(async () =>
        ProtocolBlob.from(source),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      const reader = response.body!.getReader()
      await reader.read()
      await reader.cancel('client disconnected')

      expect(sourceCancelled).toBe(true)
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('makes concurrent finalizers await the same in-flight disposal', async () => {
      let resolveDisposal!: () => void
      const { params, connection } = createTestParams(
        vi.fn(async () => ProtocolBlob.from('hello world')) as any,
      )
      const dispose = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDisposal = resolve
          }),
      )
      ;(connection as any)[Symbol.asyncDispose] = dispose
      const server = await createTestServer({}, params)

      const abortController = new AbortController()
      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        abortController.signal,
      )

      // abort backstop starts the (slow) disposal…
      abortController.abort()
      expect(dispose).toHaveBeenCalledTimes(1)

      // …and a racing cancel must ride it instead of resolving early
      let cancelled = false
      const cancelPromise = response.body!.cancel().then(() => {
        cancelled = true
      })
      await tick()
      expect(cancelled).toBe(false)

      resolveDisposal()
      await cancelPromise
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('disposes the connection at return for zero-byte blobs', async () => {
      // runtimes answer Content-Length: 0 without touching the body, so the
      // connection must not wait on a body finalizer that would never fire
      const { server, dispose } = await createLifecycleServer(async () =>
        ProtocolBlob.from(new Blob([])),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      expect(response.headers.get('Content-Length')).toBe('0')
      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe('SSE streaming', () => {
    const events = (...chunks: unknown[]) =>
      async function* () {
        yield* chunks
      }

    it('keeps the connection alive until the stream completes', async () => {
      const { server, dispose } = await createLifecycleServer(async () =>
        events({ n: 1 }, { n: 2 })(),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(dispose).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body.match(/^data: /gm)).toHaveLength(2)
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('is pull-driven instead of eagerly pumping the generator', async () => {
      let produced = 0
      const { server } = await createLifecycleServer(async () =>
        (async function* () {
          while (true) {
            produced++
            yield { produced }
          }
        })(),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )
      await tick()

      // without demand only queue pre-fill pulls may run; the old eager
      // start() pump would advance the generator unboundedly
      expect(produced).toBeLessThanOrEqual(2)

      await response.body!.getReader().cancel()
    })

    it('returns the generator and disposes the connection on client disconnect', async () => {
      let finalized = false
      const { server, dispose } = await createLifecycleServer(async () =>
        (async function* () {
          try {
            let n = 0
            while (true) yield { n: n++ }
          } finally {
            finalized = true
          }
        })(),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      const reader = response.body!.getReader()
      await reader.read()
      await reader.cancel('client disconnected')

      expect(finalized).toBe(true)
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('unwinds the generator when encoding a chunk fails', async () => {
      let finalized = false
      const { server, dispose } = await createLifecycleServer(async () =>
        (async function* () {
          try {
            // the JSON test encoder rejects BigInt: encode throws while the
            // generator is suspended at this yield
            yield { n: 1n }
            yield { n: 2 }
          } finally {
            finalized = true
          }
        })(),
      )

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      // nothing cancels an errored stream — the pull path itself must
      // return the generator or it leaks suspended forever
      await expect(response.text()).rejects.toThrow()
      expect(finalized).toBe(true)
      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('unwinds a generator blocked inside next() when the request aborts', async () => {
      let finalized = false
      const { server, dispose } = await createLifecycleServer(
        async (_connection: any, _rpc: any, signal: AbortSignal) =>
          (async function* () {
            try {
              yield { ready: true }
              // idle-wait for an event that never comes; only the rpc abort
              // signal can wake it — the finalizer must fire it before
              // cancelling the body so the queued return() can complete
              await new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                })
              })
            } finally {
              finalized = true
            }
          })(),
      )

      const abortController = new AbortController()
      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        abortController.signal,
      )

      const reader = response.body!.getReader()
      await reader.read()
      // park the source inside iterator.next() before disconnecting
      const pending = reader.read().catch(() => {})
      abortController.abort()

      await pending
      await vi.waitFor(() => {
        expect(finalized).toBe(true)
        expect(dispose).toHaveBeenCalledTimes(1)
      })
    })

    it('finalizes on request abort even when the body is never consumed', async () => {
      // mirrors the node runtime dropping an already-aborted response
      // without reading or cancelling its body
      let finalized = false
      const { server, dispose } = await createLifecycleServer(async () =>
        (async function* () {
          try {
            let n = 0
            while (true) yield { n: n++ }
          } finally {
            finalized = true
          }
        })(),
      )

      const abortController = new AbortController()
      await server.httpHandler(
        createTestRequest({}),
        null,
        abortController.signal,
      )

      abortController.abort()
      await tick()

      expect(finalized).toBe(true)
      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe('format negotiation failures', () => {
    it('maps an unsupported Accept type to 406', async () => {
      const { params } = createTestParams()
      params.onConnect = vi.fn(async () => {
        throw new UnsupportedAcceptTypeError('Unsupported Accept type')
      }) as any
      const server = await createTestServer({}, params)

      const response = await server.httpHandler(
        createTestRequest({ accept: 'application/xml' }),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(406)
    })

    it('maps an unsupported Content-Type to 415', async () => {
      const { params } = createTestParams()
      params.onConnect = vi.fn(async () => {
        throw new UnsupportedContentTypeError('Unsupported Content type')
      }) as any
      const server = await createTestServer({}, params)

      const response = await server.httpHandler(
        createTestRequest({ 'content-type': 'application/xml' }),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(415)
    })

    it('responds 500 without an encoder when onConnect fails otherwise', async () => {
      const { params } = createTestParams()
      params.onConnect = vi.fn(async () => {
        throw new Error('identity failed')
      }) as any
      const server = await createTestServer({}, params)

      const response = await server.httpHandler(
        createTestRequest({}),
        null,
        new AbortController().signal,
      )

      expect(response.status).toBe(500)
    })
  })

  describe('blob upload abort', () => {
    it('errors the handler payload stream when the request body fails', async () => {
      const bodyError = new Error('request aborted')
      let observed: unknown
      const { server } = await createLifecycleServer(
        async (_connection: any, rpc: any) => {
          try {
            await rpc.payload.toArray()
          } catch (error) {
            observed = error
          }
          return { ok: true }
        },
      )

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8))
          controller.error(bodyError)
        },
      })

      const response = await server.httpHandler(
        createTestRequest({
          'content-type': 'application/octet-stream',
          'x-neemata-blob': 'true',
        }),
        body,
        new AbortController().signal,
      )

      expect(response.status).toBe(200)
      expect(observed).toBe(bodyError)
    })
  })
})
