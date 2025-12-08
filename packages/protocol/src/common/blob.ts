import { kBlobKey } from './constants.ts'

export type ProtocolBlobMetadata = {
  type: string
  size?: number | undefined
  filename?: string | undefined
}

export interface ProtocolBlobInterface {
  readonly metadata: ProtocolBlobMetadata
  readonly [kBlobKey]: any
}

export class ProtocolBlob implements ProtocolBlobInterface {
  [kBlobKey]: true = true

  public readonly source: any
  public readonly metadata: ProtocolBlobMetadata
  public readonly encode?: () => unknown
  public readonly toJSON?: () => unknown

  constructor({
    source,
    encode,
    size,
    type = 'application/octet-stream',
    filename,
  }: {
    source: any
    encode?: () => unknown
    size?: number
    type?: string
    filename?: string
  }) {
    if (typeof size !== 'undefined' && size <= 0)
      throw new Error('Blob size is invalid')

    this.encode = encode
    this.source = source
    this.metadata = { size, type, filename }
    if (encode) {
      Object.defineProperty(this, 'toJSON', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: encode,
      })
    }
  }

  static from(
    _source: any,
    _metadata: { size?: number; type?: string; filename?: string } = {},
    _encode?: () => unknown,
  ) {
    let source: any
    const metadata = { ..._metadata }

    if (_source instanceof globalThis.ReadableStream) {
      source = _source
    } else if ('File' in globalThis && _source instanceof globalThis.File) {
      source = _source.stream()
      metadata.size ??= _source.size
      metadata.filename ??= _source.name
    } else if (_source instanceof globalThis.Blob) {
      source = _source.stream()
      metadata.size ??= _source.size
      metadata.type ??= _source.type
    } else if (typeof _source === 'string') {
      const blob = new Blob([_source])
      source = blob.stream()
      metadata.size ??= blob.size
      metadata.type ??= 'text/plain'
    } else if (globalThis.ArrayBuffer.isView(_source)) {
      const blob = new Blob([_source as ArrayBufferView<ArrayBuffer>])
      source = blob.stream()
      metadata.size ??= blob.size
    } else if (_source instanceof globalThis.ArrayBuffer) {
      const blob = new Blob([_source])
      source = blob.stream()
      metadata.size ??= blob.size
    } else {
      source = _source
    }

    return new ProtocolBlob({
      source,
      encode: _encode,
      size: metadata.size,
      type: metadata.type,
      filename: metadata.filename,
    })
  }

  // toJSON() {
  //   if (!this.encode) throw new Error('Blob format encoder is not defined')
  //   return this.encode()
  // }
}
