import type { DuplexStreamOptions } from '@nmtjs/common'
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

  #queue: Uint8Array = new Uint8Array(0)
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
        controller.enqueue(value)
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
        // the source is locked once a reader was taken, so cancelling has to
        // go through that reader
        if (sourceReader) return sourceReader.cancel(reason)
        return source.cancel(reason)
      },
    })

    this.#reader = this.readable.getReader()
    this.#sourceReader = sourceReader
  }

  async abort(reason = 'Stream aborted') {
    try {
      await this.#reader.cancel(reason)
    } finally {
      // a rejecting source cancel() must not leave the readers locked
      this.#reader.releaseLock()
      this.#sourceReader?.releaseLock()
    }
  }

  async end() {
    this.#reader.releaseLock()
    this.#sourceReader?.releaseLock()
  }

  async read(size: number) {
    if (this.#queue.byteLength === 0) {
      const { done, value } = await this.#reader.read()
      if (done) return null
      // the source may hand out any view or an ArrayBuffer; copying is only
      // needed to normalize those
      this.#queue = value instanceof Uint8Array ? value : concat(value)
    }

    const chunkSize = Math.min(size, this.#queue.byteLength)
    const chunk = this.#queue.subarray(0, chunkSize)
    this.#queue = this.#queue.subarray(chunkSize)
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
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

export class ProtocolServerStream<
  T = unknown,
> extends ProtocolServerStreamInterface<T> {}

export class ProtocolServerRPCStream<
  T = unknown,
> extends ProtocolServerStream<T> {}

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
    // ?? — zero is a valid size for empty blobs, only unknown size is NaN
    return this.metadata.size ?? Number.NaN
  }

  get type() {
    return this.metadata.type || 'application/octet-stream'
  }

  async text() {
    return decodeText(await this.bytes())
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

  // the stream is single-pass: neither form can be served without buffering
  // the whole blob, which is what streaming it is meant to avoid
  async formData(): Promise<FormData> {
    throw new Error('Method not implemented.')
  }

  slice(): Blob {
    throw new Error('Unable to slice')
  }
}
