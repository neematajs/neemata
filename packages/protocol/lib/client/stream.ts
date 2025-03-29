import { type Callback, defer } from '@nmtjs/common'
import { encodeText } from '../common/binary.ts'
import type { ProtocolBlobMetadata } from '../common/blob.ts'

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
          controller.enqueue(chunk.buffer)
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
    if (this.#queue.byteLength >= size) {
      const chunk = this.#queue.slice(0, size)
      const remaining = this.#queue.slice(size)
      this.#queue = remaining
      return chunk
    } else {
      const { done, value } = await this.#reader.read()
      if (!done) {
        const buffer = value as ArrayBuffer
        const chunk = buffer.slice(0, size)
        const remaining = buffer.slice(size)
        this.#queue = remaining
        return chunk
      }
      return null
    }
  }

  abort(error = new Error('Stream aborted')) {
    this.#reader.cancel(error)
  }

  async end() {
    if (!this.writable.locked && (await this.writable.getWriter().closed)) {
      await this.writable.close()
    }
  }
}

export class ProtocolServerStream<T = any> extends TransformStream<any, T> {
  #writer: WritableStreamDefaultWriter

  constructor(start?: Callback) {
    super({ start })
    this.#writer = this.writable.getWriter()
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (!done) yield value
      else return void 0
    }
  }

  async push(chunk: any) {
    await this.#writer.write(chunk)
  }

  async end() {
    await this.#writer.close()
  }

  abort(error = new Error('Stream aborted')) {
    this.#writer.abort(error)
  }
}

export class ProtocolServerBlobStream extends ProtocolServerStream<ArrayBuffer> {
  constructor(
    readonly id: number,
    readonly metadata: ProtocolBlobMetadata,
    start: Callback,
  ) {
    super(start)
  }

  push(chunk: ArrayBuffer) {
    return super.push(chunk)
  }

  end() {
    return super.end()
  }
}
