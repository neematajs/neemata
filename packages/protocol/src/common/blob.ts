export const BlobKey: unique symbol = Symbol.for('neemata:BlobKey')
export type BlobKey = typeof BlobKey

export type ProtocolBlobMetadata = {
  type: string
  size?: number
  filename?: string
}

export interface ProtocolBlobInterface {
  readonly metadata: ProtocolBlobMetadata
  readonly [BlobKey]: true
}

export class ProtocolBlob implements ProtocolBlobInterface {
  readonly [BlobKey] = true

  public readonly metadata: ProtocolBlobMetadata
  public readonly source: any

  constructor(
    source: any,
    size?: number,
    type = 'application/octet-stream',
    filename?: string,
  ) {
    if (typeof size !== 'undefined' && size <= 0)
      throw new Error('Blob size is invalid')

    this.source = source
    this.metadata = {
      size,
      type,
      filename,
    }
  }

  static from(
    source: any,
    metadata: {
      size?: number
      type?: string
      filename?: string
    } = {},
  ) {
    let _source: any = undefined

    if (source instanceof globalThis.ReadableStream) {
      _source = source
    } else if ('File' in globalThis && source instanceof globalThis.File) {
      _source = source.stream()
      metadata.size = source.size
      metadata.filename = source.name
    } else if (source instanceof globalThis.Blob) {
      _source = source.stream()
      metadata.size = source.size
    } else if (typeof source === 'string') {
      const blob = new Blob([source])
      _source = blob.stream()
      metadata.size = blob.size
      metadata.type = metadata.type || 'text/plain'
    } else if (source instanceof globalThis.ArrayBuffer) {
      const blob = new Blob([source])
      _source = blob.stream()
      metadata.size = blob.size
    } else {
      _source = source
    }

    return new ProtocolBlob(
      _source,
      metadata.size,
      metadata.type,
      metadata.filename,
    )
  }
}
