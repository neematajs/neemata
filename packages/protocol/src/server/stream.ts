import type { ReadableOptions } from 'node:stream'
import { PassThrough, Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'

import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import type { SendResult } from './types.ts'
import { DEFAULT_BLOB_CHUNK_SIZE, SendCredits } from '../common/flow-control.ts'

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
   * Delivery of one chunk; returning `'dropped'` signals the transport lost
   * the frame and the stream must be aborted by the owner.
   */
  chunk: (chunk: Buffer) => SendResult | undefined | void
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

  #credits = new SendCredits()
  #granted = false
  // A Readable may return more than read(size), so retain the excess rather
  // than exceeding the peer's credit or emitting oversized wire frames.
  #buffered: Buffer | null = null
  // source error that arrived before the first grant: held back so the abort
  // frame cannot precede the RpcResponse referencing this stream
  #pendingError: Error | null = null
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
      if (!this.#granted && !this.#finished) {
        this.#pendingError = error
        this.#source.destroy?.()
        return
      }
      this.#fail(error)
    })
  }

  get credits() {
    return this.#credits.available
  }

  /**
   * Adds byte credits and kicks the pump. Returns `false` when the grant
   * would overflow the credit cap — a protocol violation the owner must
   * abort on.
   */
  grant(size: number): boolean {
    if (this.#finished) return true
    if (size <= 0) return true
    if (!this.#credits.grant(size)) return false
    this.#granted = true
    if (this.#pendingError) {
      this.#fail(this.#pendingError)
      return true
    }
    this.#pump()
    return true
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
    this.#pendingError = null
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
        // never advance the producer without credit to spend its output on;
        // an ended-and-drained source may still signal End (frees no data)
        if (this.#credits.available <= 0) {
          if (
            this.#buffered === null &&
            this.#sourceEnded &&
            this.#source.readableLength === 0
          )
            this.#end()
          return
        }

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

        if (chunk.byteLength === 0) continue

        const sendSize = Math.min(
          chunk.byteLength,
          this.#credits.available,
          DEFAULT_BLOB_CHUNK_SIZE,
        )
        if (sendSize < chunk.byteLength) {
          this.#buffered = chunk.subarray(sendSize)
        }

        const frame = chunk.subarray(0, sendSize)
        this.#credits.spend(frame.byteLength)
        this.#sink.chunk(frame)
      }
    } finally {
      this.#pumping = false
    }
  }
}
