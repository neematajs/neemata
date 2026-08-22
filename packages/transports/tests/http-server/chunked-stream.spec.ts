import { describe, expect, it } from 'vitest'

import { handleChunkedStream } from '../../src/http-server/node.ts'

describe('node host', () => {
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
})
