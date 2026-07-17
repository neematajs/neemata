import { setTimeout as delay } from 'node:timers/promises'

import { BaseServerFormat, ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { HttpTransportServerRequest } from '../src/types.ts'
import {
  handleChunkedStream,
  handleFixedLengthStream,
  HttpTransport,
} from '../src/runtimes/node.ts'

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

  describe('fixed-length stream backpressure', () => {
    it('pauses reading the source stream when the client does not consume', async () => {
      const chunkSize = 256 * 1024
      const totalChunks = 100
      const chunk = new Uint8Array(chunkSize).fill(97)
      let pulled = 0

      const { url, stop } = await startServer(async () => {
        // explicit content-length -> exercises the fixed-length tryEnd path
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            controller.enqueue(chunk)
            if (pulled >= totalChunks) controller.close()
          },
        })
        return new Response(stream, {
          headers: { 'content-length': String(chunkSize * totalChunks) },
        })
      })

      try {
        const response = await fetch(`${url}/test`)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-length')).toBe(
          String(chunkSize * totalChunks),
        )

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

  describe('handleChunkedStream writable dispatcher', () => {
    // scripted stand-in for uWS HttpResponse: only the first onWritable
    // registration takes effect, matching real uWS behavior
    function createResDouble(writeResults: boolean[]) {
      const results = [...writeResults]
      let writes = 0
      let ends = 0
      let registrations = 0
      let handler: ((offset: number) => boolean) | undefined
      const res: any = {
        aborted: false,
        wakeWritable: undefined,
        cork(cb: () => void) {
          cb()
          return res
        },
        write() {
          writes++
          return results.length > 0 ? (results.shift() as boolean) : true
        },
        end() {
          ends++
          return res
        },
        onWritable(h: (offset: number) => boolean) {
          registrations++
          handler ??= h
          return res
        },
      }
      return {
        res,
        fireWritable: () => handler!(0),
        counts: () => ({ writes, ends, registrations }),
        // mirrors what the route's onAborted handler does
        abort: () => {
          res.aborted = true
          res.wakeWritable?.()
          res.cancelBody?.()
        },
      }
    }

    const chunks = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < n; i++) controller.enqueue(new Uint8Array(8))
          controller.close()
        },
      })

    const tick = () => new Promise((resolve) => setImmediate(resolve))

    it('resumes exactly one pending waiter per drain across cycles', async () => {
      const double = createResDouble([false, true, false, true])
      const pump = handleChunkedStream(double.res, chunks(4))

      await tick()
      expect(double.counts()).toEqual({ writes: 1, ends: 0, registrations: 1 })

      double.fireWritable()
      await tick()
      // resumed once: write 2 succeeded, write 3 hit backpressure again and
      // parked a second waiter without re-registering the handler
      expect(double.counts()).toEqual({ writes: 3, ends: 0, registrations: 1 })

      double.fireWritable()
      await tick()
      await pump
      expect(double.counts()).toEqual({ writes: 4, ends: 1, registrations: 1 })
    })

    it('writable callback without a pending waiter is a no-op returning true', async () => {
      const double = createResDouble([false])
      const pump = handleChunkedStream(double.res, chunks(1))

      await tick()
      expect(double.fireWritable()).toBe(true)
      await tick()
      await pump

      // stream is finished; a late drain event finds no waiter
      expect(() => double.fireWritable()).not.toThrow()
      expect(double.fireWritable()).toBe(true)
    })

    it('abort while a waiter is pending settles the wait and exits the pump', async () => {
      const double = createResDouble([false])
      const body = chunks(2)
      const pump = handleChunkedStream(double.res, body)

      await tick()
      expect(double.counts().writes).toBe(1)

      double.abort()
      await expect(pump).rejects.toThrow('Response aborted')
      expect(double.counts()).toEqual({ writes: 1, ends: 0, registrations: 1 })
      // reader lock is released on exit
      expect(() => body.getReader()).not.toThrow()
    })

    it('handles a drain cycle followed by an abort', async () => {
      const double = createResDouble([false, false])
      const pump = handleChunkedStream(double.res, chunks(3))

      await tick()
      expect(double.counts().writes).toBe(1)

      double.fireWritable()
      await tick()
      // resumed and immediately backpressured again
      expect(double.counts().writes).toBe(2)

      double.abort()
      await expect(pump).rejects.toThrow('Response aborted')
      expect(double.counts()).toEqual({ writes: 2, ends: 0, registrations: 1 })
    })

    it('abort while read() is stalled cancels the reader and exits the pump', async () => {
      const double = createResDouble([])
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        // source never produces: the pump parks inside reader.read()
        pull: () => new Promise<never>(() => {}),
        cancel() {
          cancelled = true
        },
      })
      const pump = handleChunkedStream(double.res, body)

      await tick()
      expect(double.counts().writes).toBe(0)

      double.abort()
      // reader.cancel() resolves the pending read as done and the pump exits
      // without writing or ending the aborted response
      await pump
      expect(cancelled).toBe(true)
      expect(double.counts()).toEqual({ writes: 0, ends: 0, registrations: 0 })
    })
  })

  describe('handleFixedLengthStream writable dispatcher', () => {
    // scripted stand-in for uWS HttpResponse: only the first onWritable
    // registration takes effect, matching real uWS behavior; each tryEnd
    // buffers a scripted amount of bytes so partial writes advance the offset
    function createResDouble(
      script: Array<{ accept: number; ok: boolean; done: boolean }>,
    ) {
      const steps = [...script]
      let offset = 0
      let registrations = 0
      let closes = 0
      let handler: ((offset: number) => boolean) | undefined
      const written: Uint8Array[] = []
      const res: any = {
        aborted: false,
        wakeWritable: undefined,
        cork(cb: () => void) {
          cb()
          return res
        },
        getWriteOffset: () => offset,
        tryEnd(data: Uint8Array, _totalSize: number) {
          const step = steps.shift() ?? {
            accept: data.byteLength,
            ok: true,
            done: false,
          }
          written.push(data.subarray(0, step.accept))
          offset += step.accept
          return [step.ok, step.done]
        },
        close() {
          closes++
          return res
        },
        endWithoutBody() {
          return res
        },
        onWritable(h: (offset: number) => boolean) {
          registrations++
          handler ??= h
          return res
        },
      }
      return {
        res,
        fireWritable: () => handler!(offset),
        counts: () => ({ registrations, closes }),
        written: () => Buffer.concat(written),
        // mirrors what the route's onAborted handler does
        abort: () => {
          res.aborted = true
          res.wakeWritable?.()
          res.cancelBody?.()
        },
      }
    }

    const streamOf = (...parts: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      })

    const tick = () => new Promise((resolve) => setImmediate(resolve))

    it('drains backpressure on two different chunks with one registration', async () => {
      // both chunks hit backpressure mid-write: each retry must resume from
      // where uWS stopped buffering that chunk, via a single drain handler
      const double = createResDouble([
        { accept: 3, ok: false, done: false },
        { accept: 5, ok: true, done: false },
        { accept: 4, ok: false, done: false },
        { accept: 4, ok: true, done: true },
      ])
      const chunk1 = Uint8Array.from({ length: 8 }, (_, i) => i)
      const chunk2 = Uint8Array.from({ length: 8 }, (_, i) => i + 8)
      const pump = handleFixedLengthStream(
        double.res,
        streamOf(chunk1, chunk2),
        16,
      )

      await tick()
      expect(double.counts().registrations).toBe(1)

      double.fireWritable()
      await tick()
      // chunk 1 finished, chunk 2 parked a new waiter without re-registering
      expect(double.counts().registrations).toBe(1)

      double.fireWritable()
      await pump
      expect(double.counts()).toEqual({ registrations: 1, closes: 0 })
      expect([...double.written()]).toEqual(
        Array.from({ length: 16 }, (_, i) => i),
      )
    })

    it('abort while a waiter is pending settles the wait and exits the pump', async () => {
      const double = createResDouble([{ accept: 0, ok: false, done: false }])
      const body = streamOf(new Uint8Array(8), new Uint8Array(8))
      const pump = handleFixedLengthStream(double.res, body, 16)

      await tick()
      expect(double.counts().registrations).toBe(1)

      double.abort()
      await expect(pump).rejects.toThrow('Response aborted')
      // reader lock is released on exit
      expect(() => body.getReader()).not.toThrow()
    })

    it('abort while read() is stalled cancels the reader and exits the pump', async () => {
      const double = createResDouble([])
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        // source never produces: the pump parks inside reader.read()
        pull: () => new Promise<never>(() => {}),
        cancel() {
          cancelled = true
        },
      })
      const pump = handleFixedLengthStream(double.res, body, 16)

      await tick()
      double.abort()
      // reader.cancel() resolves the pending read as done and the pump exits
      // without closing the aborted response
      await pump
      expect(cancelled).toBe(true)
      expect(double.counts()).toEqual({ registrations: 0, closes: 0 })
    })
  })
})
