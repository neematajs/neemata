import type { MaybePromise } from './types.ts'

export interface DuplexStreamOptions<O = unknown, I = O> {
  start?: (controller: globalThis.ReadableStreamDefaultController<O>) => void
  pull?: (
    controller: globalThis.ReadableStreamDefaultController<O>,
  ) => MaybePromise<void>
  cancel?: (reason: unknown) => void
  transform?: (chunk: I) => O
  close?: () => void
  readableStrategy?: globalThis.QueuingStrategy<O>
  writableStrategy?: globalThis.QueuingStrategy<I>
}

export class DuplexStream<O = unknown, I = O> {
  readonly readable: globalThis.ReadableStream<O>
  readonly writable!: globalThis.WritableStream<I>

  // writes parked on readable backpressure, released in FIFO order by pull()
  #parkedWrites: (() => void)[] = []
  // once draining, writes stop parking so close()/abort() can settle even
  // when the consumer never reads again (a parked in-flight sink.write would
  // otherwise block them forever per the streams spec)
  #draining = false

  constructor(options: DuplexStreamOptions<O, I> = {}) {
    this.readable = new globalThis.ReadableStream<O>(
      {
        cancel: (reason) => {
          // the consumer walked away: pending writes can never be read, let
          // them settle instead of deadlocking the writer
          this.releaseParkedWrites()
          options.cancel?.(reason)
        },
        start: (controller) => {
          // @ts-expect-error
          this.writable = new globalThis.WritableStream<I>(
            {
              write: (_chunk) => {
                let chunk: O
                if (options.transform) {
                  try {
                    chunk = options.transform(_chunk)
                  } catch (error) {
                    // reject the write AND error the readable — otherwise a
                    // pending reader would hang forever on a bad chunk
                    controller.error(error)
                    throw error
                  }
                } else {
                  chunk = _chunk as unknown as O
                }
                controller.enqueue(chunk)
                if (!this.#draining && (controller.desiredSize ?? 1) <= 0) {
                  return new Promise<void>((resolve) => {
                    this.#parkedWrites.push(resolve)
                  })
                }
              },
              abort: (reason) => controller.error(reason),
              close: () => {
                options?.close?.()
                try {
                  controller.close()
                } catch {
                  // Controller may already be closed (e.g., via cancel)
                }
              },
            },
            options.writableStrategy,
          )
          options.start?.(controller)
        },
        pull: (controller) => {
          this.#parkedWrites.shift()?.()
          return options.pull?.(controller)
        },
      },
      options.readableStrategy,
    )
  }

  /**
   * Settles any write parked on backpressure and disables further parking.
   * Must be called before closing/aborting the writable while the consumer
   * may no longer be reading: the streams spec makes close()/abort() wait
   * for the in-flight sink.write to settle first.
   */
  releaseParkedWrites() {
    this.#draining = true
    const parked = this.#parkedWrites
    this.#parkedWrites = []
    for (const resolve of parked) resolve()
  }
}
