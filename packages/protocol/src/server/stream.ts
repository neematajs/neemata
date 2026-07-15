import type { ReadableOptions } from 'node:stream'
import { PassThrough, Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'

import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'

export class ProtocolClientStream extends PassThrough {
  readonly #read?: ReadableOptions['read']

  constructor(
    public readonly id: number,
    public readonly metadata: ProtocolBlobMetadata,
    options?: ReadableOptions,
  ) {
    const { read, ...rest } = options ?? {}
    super(rest)
    this.#read = read
  }

  override _read(size: number): void {
    if (this.#read) {
      this.#read.call(this, size)
    }
    super._read(size)
  }
}

export type ProtocolServerStreamSink = {
  /**
   * Delivery of one chunk; returning `false` signals the transport dropped
   * the frame and the stream must be aborted by the owner.
   */
  chunk: (chunk: Buffer) => boolean | null | undefined | void
  end: () => void
  error: (error: Error) => void
}

/**
 * Credit-driven pump for server->client blob downloads: the source is never
 * piped/flowed; bytes are read and emitted to the sink only against credits
 * granted by the consumer (`grant`), so in-flight data is bounded by what the
 * peer explicitly asked for. Nothing (not even `end`) is emitted before the
 * first grant, which preserves the RpcResponse-before-stream-frames ordering.
 */
export class ProtocolServerStream {
  public readonly id: number
  public readonly metadata: ProtocolBlobMetadata
  readonly #source: Readable
  readonly #sink: ProtocolServerStreamSink

  #credits = 0
  #granted = false
  // remainder of a source chunk larger than the credits available at the time
  #buffered: Buffer | null = null
  #sourceEnded = false
  #finished = false
  // sink callbacks may re-enter (abort -> destroy) while the loop is running
  #pumping = false

  constructor(id: number, blob: ProtocolBlob, sink: ProtocolServerStreamSink) {
    let readable: Readable

    if (blob.source instanceof Readable) {
      readable = blob.source
    } else if (blob.source instanceof ReadableStream) {
      readable = Readable.fromWeb(blob.source as ReadableStream)
    } else {
      throw new Error('Invalid source type')
    }

    this.id = id
    this.metadata = blob.metadata
    this.#sink = sink
    this.#source = readable

    this.#source.on('readable', () => this.#pump())
    this.#source.on('end', () => {
      this.#sourceEnded = true
      this.#pump()
    })
    this.#source.on('error', (error) => {
      this.#fail(error)
    })
  }

  get credits() {
    return this.#credits
  }

  grant(size: number): void {
    if (this.#finished) return
    if (size <= 0) return
    this.#granted = true
    this.#credits += size
    this.#pump()
  }

  destroy(error?: Error | null): void {
    if (error) {
      this.#fail(error)
    } else {
      this.#finished = true
      this.#buffered = null
      this.#source.destroy?.()
    }
  }

  #fail(error: Error): void {
    if (this.#finished) return
    this.#finished = true
    this.#buffered = null
    this.#source.destroy?.(error)
    this.#sink.error(error)
  }

  #end(): void {
    if (this.#finished) return
    this.#finished = true
    this.#sink.end()
  }

  #pump(): void {
    if (this.#pumping || this.#finished || !this.#granted) return
    this.#pumping = true
    try {
      while (!this.#finished) {
        let chunk = this.#buffered
        this.#buffered = null

        if (chunk === null) {
          const read = this.#source.read()
          if (read === null) {
            // source drained: either truly finished or waiting for 'readable'
            if (this.#sourceEnded) this.#end()
            return
          }
          chunk = Buffer.isBuffer(read) ? read : Buffer.from(read)
        }

        if (this.#credits <= 0) {
          this.#buffered = chunk
          return
        }

        if (chunk.byteLength > this.#credits) {
          this.#buffered = chunk.subarray(this.#credits)
          chunk = chunk.subarray(0, this.#credits)
        }

        this.#credits -= chunk.byteLength
        this.#sink.chunk(chunk)
      }
    } finally {
      this.#pumping = false
    }
  }
}
