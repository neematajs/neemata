import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import type {
  ProtocolServerStream,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import { ProtocolClientBlobStream } from '@nmtjs/protocol/client'

export class ClientStreams {
  readonly #collection = new Map<number, ProtocolClientBlobStream>()

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(
    source: ReadableStream,
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) {
    const stream = new ProtocolClientBlobStream(source, streamId, metadata)
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number, error?: Error) {
    const stream = this.get(streamId)
    stream.abort(error)
    this.remove(streamId)
  }

  pull(streamId: number, size: number) {
    const stream = this.get(streamId)
    return stream.read(size)
  }

  end(streamId: number) {
    this.get(streamId).end()
    this.remove(streamId)
  }

  clear(error?: Error) {
    if (error) {
      for (const stream of this.#collection.values()) {
        stream.abort(error)
      }
    }
    this.#collection.clear()
  }
}

export class ServerStreams<
  T extends ProtocolServerStreamInterface = ProtocolServerStreamInterface,
> {
  readonly #collection = new Map<number, T>()

  has(streamId: number) {
    return this.#collection.has(streamId)
  }

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(streamId: number, stream: T) {
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number) {
    if (this.has(streamId)) {
      const stream = this.get(streamId)
      stream.abort()
      this.remove(streamId)
    }
  }

  async push(streamId: number, chunk: ArrayBufferView) {
    const stream = this.get(streamId)
    return await stream.push(chunk)
  }

  end(streamId: number) {
    const stream = this.get(streamId)
    stream.end()
    this.remove(streamId)
  }

  clear(error?: Error) {
    if (error) {
      for (const stream of this.#collection.values()) {
        stream.abort(error)
      }
    }
    this.#collection.clear()
  }
}
