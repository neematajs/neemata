import type { Future } from '@nmtjs/common'
import { createPromise, defer, MAX_UINT16 } from '@nmtjs/common'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import { concat, encodeText } from '../common/binary.ts'
import { BlobKey } from '../common/blob.ts'

export class ProtocolClientBlobStream
  extends TransformStream<any, ArrayBufferView>
  implements ProtocolBlobInterface
{
  readonly [BlobKey] = true

  #queue: Uint8Array
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
          controller.enqueue(new Uint8Array(chunk))
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk)
        } else if (typeof chunk === 'string') {
          controller.enqueue(encodeText(chunk))
        } else {
          throw new Error(
            'Invalid chunk data type. Expected ArrayBuffer, Uint8Array, or string.',
          )
        }
      },
    })

    this.#queue = new Uint8Array(0)
    this.#reader = this.readable.getReader()
  }

  async read(size: number) {
    while (this.#queue.byteLength < size) {
      const { done, value } = await this.#reader.read()
      if (done) {
        if (this.#queue.byteLength > 0) {
          const chunk = this.#queue
          this.#queue = new Uint8Array(0)
          return chunk
        }
        return null
      }
      const buffer = value
      this.#queue = concat(this.#queue, buffer)
    }
    const chunk = this.#queue.subarray(0, size)
    this.#queue = this.#queue.subarray(size)
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
  end(): void
  push(chunk: T): void
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

  push(chunk: T) {
    this.#writer.write(chunk)
  }

  end() {
    this.#writer.close()
  }

  abort(error = new Error('Stream aborted')) {
    this.#writer.abort(error)
  }
}

export class ProtocolServerBlobStream
  extends ReadableStream<ArrayBufferView>
  implements
    ProtocolBlobInterface,
    ProtocolServerStreamInterface<ArrayBufferView>
{
  readonly [BlobKey] = true

  #chunk: Future<ArrayBufferView | null>

  constructor(
    readonly id: number,
    readonly metadata: ProtocolBlobMetadata,
    pull: (size: number) => void,
  ) {
    super({
      pull: async (controller) => {
        pull(controller.desiredSize || MAX_UINT16)
        const chunk = await this.#chunk.promise
        if (chunk === null) {
          controller.close()
        } else {
          controller.enqueue(chunk)
          this.#chunk = createPromise<ArrayBufferView | null>()
        }
      },
    })
    this.#chunk = createPromise<ArrayBufferView | null>()
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (!done) yield value
      else break
    }
  }

  push(chunk: ArrayBufferView) {
    this.#chunk.resolve(chunk)
  }

  end() {
    this.#chunk.resolve(null)
  }

  abort(error = new Error('Stream aborted')) {
    this.#chunk.reject(error)
  }
}
