import { describe, expect, it } from 'vitest'

import { handleFixedLengthStream } from '../../src/http-server/node.ts'

describe('node host', () => {
  describe('handleFixedLengthStream writable dispatcher', () => {
    // Scripted stand-in for uWS HttpResponse: only the first onWritable
    // registration takes effect, and partial writes advance the global offset.
    function createResDouble(
      script: Array<{ accept: number; ok: boolean; done: boolean }>,
    ) {
      const steps = [...script]
      let offset = 0
      let registrations = 0
      let closes = 0
      let handler: ((offset: number) => boolean) | undefined
      const written: number[] = []
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
          written.push(...data.subarray(0, step.accept))
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
        written: () => written,
        // Mirrors the route's onAborted handler so pending waits and reads
        // observe the same cancellation order as production.
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

    it('drains two partially written chunks with one registration and current offsets', async () => {
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
      // Chunk 1 finished and chunk 2 parked without replacing uWS's handler.
      expect(double.counts().registrations).toBe(1)

      double.fireWritable()
      await pump
      expect(double.counts()).toEqual({ registrations: 1, closes: 0 })
      expect(double.written()).toEqual(Array.from({ length: 16 }, (_, i) => i))
    })

    it('settles a pending writable waiter on abort', async () => {
      const double = createResDouble([{ accept: 0, ok: false, done: false }])
      const body = streamOf(new Uint8Array(8), new Uint8Array(8))
      const pump = handleFixedLengthStream(double.res, body, 16)

      await tick()
      expect(double.counts().registrations).toBe(1)

      double.abort()
      await expect(pump).rejects.toThrow('Response aborted')
      expect(() => body.getReader()).not.toThrow()
    })

    it('cancels a stalled read on abort', async () => {
      const double = createResDouble([])
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        // The source intentionally never produces so the pump parks in read().
        pull: () => new Promise<never>(() => {}),
        cancel() {
          cancelled = true
        },
      })
      const pump = handleFixedLengthStream(double.res, body, 16)

      await tick()
      double.abort()
      await pump
      expect(cancelled).toBe(true)
      expect(double.counts()).toEqual({ registrations: 0, closes: 0 })
    })

    it('cancels the source for a zero-length response', async () => {
      const double = createResDouble([])
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      })

      await handleFixedLengthStream(double.res, body, 0)
      expect(cancelled).toBe(true)
      expect(() => body.getReader()).not.toThrow()
    })

    it('cancels the source when the response finishes before the stream', async () => {
      const double = createResDouble([{ accept: 8, ok: true, done: true }])
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8))
        },
        cancel() {
          cancelled = true
        },
      })

      await handleFixedLengthStream(double.res, body, 8)
      expect(cancelled).toBe(true)
      expect(() => body.getReader()).not.toThrow()
    })
  })
})
