// TODO: add proper queueing/backpressure strategy support

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

  constructor(options: DuplexStreamOptions<O, I> = {}) {
    this.readable = new globalThis.ReadableStream<O>(
      {
        cancel: options.cancel,
        start: (controller) => {
          // @ts-expect-error
          this.writable = new globalThis.WritableStream<I>(
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
