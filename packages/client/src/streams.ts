import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import type { ProtocolServerStreamInterface } from '@nmtjs/protocol/client'
import { ProtocolClientBlobStream } from '@nmtjs/protocol/client'

export class ClientStreams {
  readonly #collection = new Map<number, ProtocolClientBlobStream>()

  get size() {
    return this.#collection.size
  }

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

  async abort(streamId: number, reason?: any) {
    const stream = this.#collection.get(streamId)
    if (!stream) return // Stream already cleaned up
    try {
      await stream.abort(reason)
    } finally {
      // a rejecting source cancel() must not leak the manager entry
      this.remove(streamId)
    }
  }

  pull(streamId: number, size: number) {
    const stream = this.get(streamId)
    return stream.read(size)
  }

  async end(streamId: number) {
    await this.get(streamId).end()
    this.remove(streamId)
  }

  async clear(reason?: any) {
    if (reason) {
      const abortPromises = [...this.#collection.values()].map((stream) =>
        stream.abort(reason),
      )
      // allSettled: one rejecting cancel() must not stop clearing the rest
      await Promise.allSettled(abortPromises)
    }
    this.#collection.clear()
  }
}

export class ServerStreams<
  T extends ProtocolServerStreamInterface = ProtocolServerStreamInterface,
> {
  readonly #collection = new Map<number, T>()
  readonly #writers = new Map<number, WritableStreamDefaultWriter>()

  get size() {
    return this.#collection.size
  }

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
    this.#writers.set(
      streamId,
      stream.writable.getWriter() as WritableStreamDefaultWriter,
    )
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
    this.#writers.delete(streamId)
  }

  async abort(streamId: number, reason?: unknown) {
    if (this.has(streamId)) {
      // a write parked on backpressure would block abort() from settling
      this.#collection.get(streamId)?.releaseParkedWrites()
      const writer = this.#writers.get(streamId)
      if (writer) {
        await writer.abort(reason)
        writer.releaseLock()
      }
      this.remove(streamId)
    }
  }

  async push(streamId: number, chunk: ArrayBufferView) {
    const writer = this.#writers.get(streamId)
    if (writer) {
      return await writer.write(chunk)
    }
  }

  async end(streamId: number) {
    // no more data is coming: flush parked writes into the readable queue so
    // close() can settle while the consumer drains at its own pace
    this.#collection.get(streamId)?.releaseParkedWrites()
    const writer = this.#writers.get(streamId)
    if (writer) {
      await writer.close()
      writer.releaseLock()
    }
    this.remove(streamId)
  }

  async clear(reason?: any) {
    if (reason) {
      for (const stream of this.#collection.values()) {
        stream.releaseParkedWrites()
      }
      const abortPromises = [...this.#writers.values()].map((writer) =>
        writer.abort(reason).finally(() => writer.releaseLock()),
      )
      await Promise.allSettled(abortPromises)
    }
    this.#collection.clear()
    this.#writers.clear()
  }
}
