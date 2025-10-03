import { defer } from '@nmtjs/common'

import type { ProtocolBlobMetadata } from '../common/blob.ts'
import { concat, encodeText } from '../common/binary.ts'

export class ProtocolClientBlobStream extends TransformStream<
  any,
  ArrayBuffer
> {
  #queue: ArrayBuffer
  #reader: ReadableStreamDefaultReader

  constructor(
    readonly source: ReadableStream,
    readonly id: number,
    readonly metadata: ProtocolBlobMetadata,
  ) {
    super({
      start: () => {
        defer(() => source.pipeThrough(this))
      },
      transform: (chunk, controller) => {
        if (chunk instanceof ArrayBuffer) {
          controller.enqueue(chunk)
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk.buffer as unknown as ArrayBuffer)
        } else if (typeof chunk === 'string') {
          controller.enqueue(encodeText(chunk))
        } else {
          throw new Error(
            'Invalid chunk data type. Expected ArrayBuffer, Uint8Array, or string.',
          )
        }
      },
    })

    this.#queue = new ArrayBuffer(0)
    this.#reader = this.readable.getReader()
  }

  async read(size: number) {
    while (this.#queue.byteLength < size) {
      const { done, value } = await this.#reader.read()
      if (done) {
        if (this.#queue.byteLength > 0) {
          const chunk = this.#queue
          this.#queue = new ArrayBuffer(0)
          return chunk
        }
        return null
      }
      const buffer = value as ArrayBuffer
      this.#queue = concat(this.#queue, buffer)
    }
    const chunk = this.#queue.slice(0, size)
    this.#queue = this.#queue.slice(size)
    return chunk
  }

  abort(error = new Error('Stream aborted')) {
    this.#reader.cancel(error)
    this.source.cancel(error)
  }

  end() {
    return this.source.cancel('Stream ended')
  }
}

export interface ProtocolServerStreamInterface<T = any> {
  [Symbol.asyncIterator](): AsyncGenerator<T>
  abort(error?: Error): void
}

export class ProtocolServerStream<T = any>
  extends TransformStream<any, T>
  implements ProtocolServerStreamInterface<T>
{
  #writer: WritableStreamDefaultWriter

  constructor(options?: Transformer<any, T>) {
    super(options)

    this.#writer = this.writable.getWriter()
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (!done) yield value
      else break
    }
  }

  async push(chunk: T) {
    await this.#writer.write(chunk)
  }

  async end() {
    await this.#writer.close()
  }

  async abort(error = new Error('Stream aborted')) {
    await this.#writer.abort(error)
  }
}

export class ProtocolServerBlobStream extends ProtocolServerStream<ArrayBuffer> {
  constructor(
    readonly id: number,
    readonly metadata: ProtocolBlobMetadata,
    options?: Transformer<any, ArrayBuffer>,
  ) {
    super(options)
  }
}
