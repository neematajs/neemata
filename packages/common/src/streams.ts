import type { MaybePromise } from './types.ts'

export interface DuplexStreamOptions<O = unknown, I = O> {
  start?: (controller: globalThis.ReadableStreamDefaultController<O>) => void
  pull?: (
    controller: globalThis.ReadableStreamDefaultController<O>,
    consumed?: O,
  ) => MaybePromise<void>
  cancel?: (reason: unknown) => MaybePromise<void>
  transform?: (chunk: I) => O
  close?: () => void
  readableStrategy?: globalThis.QueuingStrategy<O>
  writableStrategy?: globalThis.QueuingStrategy<I>
}

export class DuplexStream<O = unknown, I = O> {
  readonly readable: globalThis.ReadableStream<O>
  readonly writable: globalThis.WritableStream<I>

  // writes parked on readable backpressure, released in FIFO order by pull()
  #parkedWrites: (() => void)[] = []
  #queuedChunks: O[] = []
  // once draining, writes stop parking so close()/abort() can settle even
  // when the consumer never reads again (a parked in-flight sink.write would
  // otherwise block them forever per the streams spec)
  #draining = false

  constructor(options: DuplexStreamOptions<O, I> = {}) {
    // the readable controller is the writable's sink; ReadableStream runs
    // start() synchronously, so it is assigned before the writable is built
    let controller!: globalThis.ReadableStreamDefaultController<O>

    this.readable = new globalThis.ReadableStream<O>(
      {
        cancel: (reason) => {
          // the consumer walked away: pending writes can never be read, let
          // them settle instead of deadlocking the writer
          this.releaseParkedWrites()
          // returned so cancel() awaits async cleanup and surfaces rejections
          return options.cancel?.(reason)
        },
        start: (readableController) => {
          controller = readableController
          options.start?.(controller)
        },
        pull: () => {
          const consumed = this.#queuedChunks.shift()
          this.#parkedWrites.shift()?.()
          return options.pull?.(controller, consumed)
        },
      },
      options.readableStrategy,
    )

    this.writable = new globalThis.WritableStream<I>(
      {
        write: (input) => {
          let chunk: O
          if (options.transform) {
            try {
              chunk = options.transform(input)
            } catch (error) {
              // reject the write AND error the readable — otherwise a
              // pending reader would hang forever on a bad chunk
              controller.error(error)
              throw error
            }
          } else {
            chunk = input as unknown as O
          }
          controller.enqueue(chunk)
          this.#queuedChunks.push(chunk)
          if (!this.#draining && (controller.desiredSize ?? 1) <= 0) {
            return new Promise<void>((resolve) => {
              this.#parkedWrites.push(resolve)
            })
          }
        },
        abort: (reason) => controller.error(reason),
        close: () => {
          options.close?.()
          try {
            controller.close()
          } catch {
            // Controller may already be closed (e.g., via cancel)
          }
        },
      },
      options.writableStrategy,
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
