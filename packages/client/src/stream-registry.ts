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
      const pending = Array.from(this.#collection.values()).map((stream) =>
        stream.abort(reason),
      )
      // allSettled: one rejecting cancel() must not stop clearing the rest
      await Promise.allSettled(pending)
    }
    this.#collection.clear()
  }
}

export class ServerStreams<
  T extends ProtocolServerStreamInterface = ProtocolServerStreamInterface,
> {
  readonly #collection = new Map<
    number,
    { stream: T; writer: WritableStreamDefaultWriter }
  >()

  get size() {
    return this.#collection.size
  }

  has(streamId: number) {
    return this.#collection.has(streamId)
  }

  get(streamId: number) {
    const entry = this.#collection.get(streamId)
    if (!entry) throw new Error('Stream not found')
    return entry.stream
  }

  add(streamId: number, stream: T) {
    const writer = stream.writable.getWriter() as WritableStreamDefaultWriter
    this.#collection.set(streamId, { stream, writer })
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  async abort(streamId: number, reason?: unknown) {
    const entry = this.#collection.get(streamId)
    if (!entry) return

    // a write parked on backpressure would block abort() from settling
    entry.stream.releaseParkedWrites()
    await entry.writer.abort(reason)
    entry.writer.releaseLock()
    this.remove(streamId)
  }

  async push(streamId: number, chunk: ArrayBufferView) {
    const entry = this.#collection.get(streamId)
    if (entry) {
      return await entry.writer.write(chunk)
    }
  }

  async end(streamId: number) {
    const entry = this.#collection.get(streamId)
    if (entry) {
      // no more data is coming: flush parked writes into the readable queue so
      // close() can settle while the consumer drains at its own pace
      entry.stream.releaseParkedWrites()
      await entry.writer.close()
      entry.writer.releaseLock()
    }
    this.remove(streamId)
  }

  async clear(reason?: unknown) {
    if (reason) {
      const pending: Promise<void>[] = []

      for (const { stream, writer } of this.#collection.values()) {
        stream.releaseParkedWrites()
        pending.push(writer.abort(reason).finally(() => writer.releaseLock()))
      }

      await Promise.allSettled(pending)
    }
    this.#collection.clear()
  }
}
