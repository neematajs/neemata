import type { DuplexStreamSink } from '@nmtjs/common'
import { DuplexStream, defer } from '@nmtjs/common'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import { concat, decodeText, encodeText } from '../common/binary.ts'
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
    return this.#reader.cancel(error)
  }

  end() {
    return this.#reader.cancel('Stream ended')
  }
}

export abstract class ProtocolServerStreamInterface<
  O = unknown,
> extends DuplexStream<O, ArrayBufferView> {
  async *[Symbol.asyncIterator]() {
    const reader = this.readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (!done) yield value
      else break
    }
    reader.releaseLock()
  }
}

export class ProtocolServerStream<T = unknown>
  extends ProtocolServerStreamInterface<T>
  implements ProtocolServerStreamInterface<T> {}

export class ProtocolServerBlobStream
  extends ProtocolServerStreamInterface<ArrayBufferView>
  implements ProtocolBlobInterface, Blob
{
  readonly [BlobKey] = true

  constructor(
    readonly metadata: ProtocolBlobMetadata,
    options?: DuplexStreamSink<ArrayBufferView, ArrayBufferView>,
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
