// TODO: add proper queueing/backpressure strategy support

import type { Async } from './types.ts'

export interface DuplexStreamOptions<O = unknown, I = O> {
  start?: (controller: ReadableStreamDefaultController<O>) => void
  pull?: (controller: ReadableStreamDefaultController<O>) => Async<void>
  cancel?: (reason: unknown) => void
  transform?: (chunk: I) => O
  close?: () => void
  readableStrategy?: QueuingStrategy<O>
  writableStrategy?: QueuingStrategy<I>
}

export class DuplexStream<O = unknown, I = O> {
  readonly readable: ReadableStream<O>
  readonly writable!: WritableStream<I>

  constructor(options: DuplexStreamOptions<O, I> = {}) {
    this.readable = new ReadableStream<O>(
      {
        cancel: options.cancel,
        start: (controller) => {
          // @ts-expect-error
          this.writable = new WritableStream<I>(
            {
              write: (_chunk) => {
                const chunk = options?.transform
                  ? options?.transform(_chunk)
                  : _chunk
                controller.enqueue(chunk as O)
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
        pull: options?.pull,
      },
      options.readableStrategy,
    )
  }
}
