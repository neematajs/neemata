import { PassThrough, Readable, type TransformOptions } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import type { ApiBlob, ApiBlobMetadata } from '@nmtjs/common'

export class ServerUpStream extends Readable {
  public readonly metadata: ApiBlobMetadata
  constructor(metadata: ApiBlobMetadata, options?: TransformOptions) {
    super(options)
    this.metadata = metadata
  }
}

export class ServerDownStream extends PassThrough {
  public readonly id: number
  public readonly blob: ApiBlob

  constructor(id: number, blob: ApiBlob) {
    super({
      construct: (callback) => {
        if (blob.source instanceof Readable) {
          blob.source.pipe(this)
        } else if (blob.source instanceof ReadableStream) {
          const readable = Readable.fromWeb(blob.source as ReadableStream)
          readable.pipe(this)
        }
        callback()
      },
    })

    this.id = id
    this.blob = blob
  }
}
