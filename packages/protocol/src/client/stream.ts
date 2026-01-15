import type { Callback, DuplexStreamOptions } from '@nmtjs/common'
import { DuplexStream } from '@nmtjs/common'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import { concat, decodeText, encodeText } from '../common/binary.ts'
import { kBlobKey } from '../common/constants.ts'

export class ProtocolClientBlobStream
  extends DuplexStream<any, ArrayBufferView>
  implements ProtocolBlobInterface
{
  readonly [kBlobKey] = true

  #queue: Uint8Array
  #reader: ReadableStreamDefaultReader
  #sourceReader: ReadableStreamDefaultReader | null = null

  constructor(
    readonly source: ReadableStream,
    readonly id: number,
    readonly metadata: ProtocolBlobMetadata,
  ) {
    let sourceReader: ReadableStreamDefaultReader | null = null
    super({
      start: () => {
        sourceReader = source.getReader()
      },
      pull: async (controller) => {
        const { done, value } = await sourceReader!.read()
        if (done) {
          controller.close()
          return
        }
        const chunk = value
        controller.enqueue(
          chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      },
      transform: (chunk) => {
        if (chunk instanceof ArrayBuffer) {
          return new Uint8Array(chunk)
        } else if (chunk instanceof Uint8Array) {
          return chunk
        } else if (typeof chunk === 'string') {
          return encodeText(chunk)
        } else {
          throw new Error(
            'Invalid chunk data type. Expected ArrayBuffer, Uint8Array, or string.',
          )
        }
      },
      cancel: (reason) => {
        // Use reader.cancel() if reader exists (stream is locked), otherwise source.cancel()
        if (sourceReader) {
          sourceReader.cancel(reason)
        } else {
          source.cancel(reason)
        }
      },
    })

    this.#queue = new Uint8Array(0)
    this.#reader = this.readable.getReader()
    this.#sourceReader = sourceReader
  }

  async abort(reason = 'Stream aborted') {
    await this.#reader.cancel(reason)
    this.#reader.releaseLock()
    this.#sourceReader?.releaseLock()
  }

  async end() {
    // Release the reader lock when the stream is finished
    this.#reader.releaseLock()
    this.#sourceReader?.releaseLock()
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
}

export abstract class ProtocolServerStreamInterface<
  O = unknown,
> extends DuplexStream<O, ArrayBufferView> {
  async *[Symbol.asyncIterator]() {
    const reader = this.readable.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (!done) yield value
        else break
      }
    } finally {
      reader.releaseLock()
    }
  }
}

export class ProtocolServerStream<T = unknown>
  extends ProtocolServerStreamInterface<T>
  implements ProtocolServerStreamInterface<T> {}

export class ProtocolServerRPCStream<
  T = unknown,
> extends ProtocolServerStream<T> {
  createAsyncIterable(onDone: Callback) {
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = this[Symbol.asyncIterator]()
        return {
          async next() {
            const result = await iterator.next()
            if (result.done) onDone()
            return result
          },
          async return(value) {
            onDone()
            return iterator.return?.(value) ?? { done: true, value }
          },
          async throw(error) {
            onDone()
            return iterator.throw?.(error) ?? Promise.reject(error)
          },
        }
      },
    }
  }
}

export class ProtocolServerBlobStream
  extends ProtocolServerStreamInterface<ArrayBufferView>
  implements ProtocolBlobInterface, Blob
{
  readonly [kBlobKey] = true

  constructor(
    readonly metadata: ProtocolBlobMetadata,
    options?: DuplexStreamOptions<ArrayBufferView, ArrayBufferView>,
  ) {
    super(options)
  }

  get size() {
    return this.metadata.size || Number.NaN
  }

  get type() {
    return this.metadata.type || 'application/octet-stream'
  }

  async text() {
    const chunks: ArrayBufferView[] = []
    for await (const chunk of this) chunks.push(chunk)
    return decodeText(concat(...chunks))
  }

  async bytes() {
    const chunks: ArrayBufferView[] = []
    for await (const chunk of this) chunks.push(chunk)
    return concat(...chunks)
  }

  async arrayBuffer() {
    const bytes = await this.bytes()
    return bytes.buffer
  }

  async json<T = unknown>() {
    const text = await this.text()
    return JSON.parse(text) as T
  }

  stream() {
    const transform = new TransformStream<ArrayBufferView, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(
          chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        )
      },
    })
    this.readable.pipeThrough(transform)
    return transform.readable as ReadableStream<Uint8Array<ArrayBuffer>>
  }

  /**
   * Throws an error
   */
  async formData(): Promise<FormData> {
    throw new Error('Method not implemented.')
  }

  /**
   * Throws an error
   */
  slice(): Blob {
    throw new Error('Unable to slice')
  }
}
