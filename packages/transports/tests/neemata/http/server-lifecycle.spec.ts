import { setImmediate as tick } from 'node:timers/promises'

import { GatewayInjectables } from '@nmtjs/gateway'
import { ProtocolBlob } from '@nmtjs/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTestParams,
  createTestRequest,
  createTestServer,
} from './_helpers/test-utils.ts'

async function createLifecycleHandler(onRpc: (...args: any[]) => unknown) {
  const { params, connection } = createTestParams(vi.fn(onRpc) as any)
  const dispose = vi.fn(async () => {})
  connection[Symbol.asyncDispose] = dispose
  const handler = await createTestServer({}, params)
  return { dispose, handler }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HTTP response body lifecycle', () => {
  it('disposes buffered calls before returning', async () => {
    const { dispose, handler } = await createLifecycleHandler(() => ({
      ok: true,
    }))

    const response = await handler.handle(createTestRequest({}))

    expect(response.status).toBe(200)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps blob and handler-built Response connections alive through completion', async () => {
    for (const result of [
      ProtocolBlob.from('blob body'),
      new Response('response body'),
    ]) {
      const { dispose, handler } = await createLifecycleHandler(() => result)

      const response = await handler.handle(createTestRequest({}))
      expect(dispose).not.toHaveBeenCalled()

      await expect(response.text()).resolves.toMatch(/body$/)
      expect(dispose).toHaveBeenCalledOnce()
    }
  })

  it('disposes the body call before its HTTP connection', async () => {
    const events: string[] = []
    const callDispose = vi.fn(async () => {
      events.push('call')
    })
    const { params, connection } = createTestParams(
      vi.fn(async (...args: any[]) => {
        const registrar = args.find(
          (value) => value?.token === GatewayInjectables.deferRpcResultDisposal,
        )
        registrar.value(callDispose)
        return new Response('response body')
      }) as any,
    )
    connection[Symbol.asyncDispose] = vi.fn(async () => {
      events.push('connection')
    })
    const handler = await createTestServer({}, params)

    const response = await handler.handle(createTestRequest({}))
    expect(events).toEqual([])

    await expect(response.text()).resolves.toBe('response body')
    expect(events).toEqual(['call', 'connection'])
  })

  it('disposes when a response body errors', async () => {
    const bodyError = new Error('body failed')
    const { dispose, handler } = await createLifecycleHandler(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(bodyError)
            },
          }),
        ),
    )

    const response = await handler.handle(createTestRequest({}))

    await expect(response.text()).rejects.toBe(bodyError)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('cancels the source and disposes on direct body cancellation', async () => {
    const sourceCancel = vi.fn()
    const { dispose, handler } = await createLifecycleHandler(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
            cancel: sourceCancel,
          }),
        ),
    )

    const response = await handler.handle(createTestRequest({}))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('client disconnected')

    expect(sourceCancel).toHaveBeenCalledWith('client disconnected')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes on request abort even when the response body is not consumed', async () => {
    const sourceCancel = vi.fn()
    const { dispose, handler } = await createLifecycleHandler(
      () =>
        new Response(
          new ReadableStream({
            cancel: sourceCancel,
          }),
        ),
    )
    const requestController = new AbortController()
    const request = new Request('http://localhost/testProcedure', {
      method: 'POST',
      signal: requestController.signal,
    })
    const response = await handler.handle(request)
    expect(response.body).not.toBeNull()

    requestController.abort('request aborted')
    await tick()

    expect(sourceCancel).toHaveBeenCalledWith('request aborted')
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('HTTP SSE lifecycle', () => {
  it('pulls from the generator on demand and disposes after completion', async () => {
    let produced = 0
    const { dispose, handler } = await createLifecycleHandler(() =>
      (async function* () {
        produced++
        yield { produced }
        produced++
        yield { produced }
      })(),
    )

    const response = await handler.handle(createTestRequest({}))
    await tick()
    expect(produced).toBeLessThanOrEqual(2)
    expect(dispose).not.toHaveBeenCalled()

    const text = await response.text()
    expect(text.match(/^data: /gm)).toHaveLength(2)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('bounds direct cancellation when next() ignores abort forever', async () => {
    vi.useFakeTimers()
    let finalized = false
    let markBlocked!: () => void
    const blocked = new Promise<void>((resolve) => (markBlocked = resolve))
    const { dispose, handler } = await createLifecycleHandler(() =>
      (async function* () {
        try {
          yield { ready: true }
          markBlocked()
          await new Promise(() => {})
        } finally {
          finalized = true
        }
      })(),
    )

    const response = await handler.handle(createTestRequest({}))
    const reader = response.body!.getReader()
    await reader.read()
    void reader.read()
    await blocked

    let cancelled = false
    const cancellation = reader.cancel().then(() => {
      cancelled = true
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(cancelled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await cancellation
    expect(cancelled).toBe(true)
    expect(finalized).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
