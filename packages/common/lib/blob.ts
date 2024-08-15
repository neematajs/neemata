import type { ApiBlobMetadata } from './types.ts'

export interface ApiBlobInterface {
  readonly metadata: ApiBlobMetadata
}

export type Exact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false

export class ApiBlob implements ApiBlobInterface {
  public readonly metadata: ApiBlobMetadata
  public readonly source: any

  constructor(
    source: any,
    size = -1,
    type = 'application/octet-stream',
    filename?: string,
  ) {
    if (size < -1 || size === 0) throw new Error('Blob size is invalid')

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

    if (source instanceof ReadableStream) {
      _source = source
    } else if (source instanceof File) {
      _source = source.stream()
      metadata.size = source.size
      metadata.filename = source.name
    } else if (source instanceof Blob) {
      _source = source.stream()
      metadata.size = source.size
    } else if (typeof source === 'string') {
      const blob = new Blob([source])
      _source = blob.stream()
      metadata.size = blob.size
      metadata.type = metadata.type || 'text/plain'
    } else if (source instanceof ArrayBuffer) {
      const blob = new Blob([source])
      _source = blob.stream()
      metadata.size = blob.size
    } else {
      _source = source
    }

    return new ApiBlob(_source, metadata.size, metadata.type, metadata.filename)
  }
}
