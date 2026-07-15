import { kBlobKey } from './constants.ts'

export type ProtocolBlobMetadata = {
  type: string
  size?: number | undefined
  filename?: string | undefined
}

export interface ProtocolBlobInterface {
  readonly metadata: ProtocolBlobMetadata
  readonly streamId?: number
  readonly [kBlobKey]: any
}

export const createProtocolBlobReference = (
  streamId: number,
  metadata: ProtocolBlobMetadata,
): ProtocolBlobInterface => {
  return Object.defineProperties(
    {},
    {
      metadata: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: metadata,
      },
      streamId: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: streamId,
      },
      [kBlobKey]: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: true,
      },
    },
  ) as ProtocolBlobInterface
}

export const getProtocolBlobStreamId = (blob: ProtocolBlobInterface) => {
  if (typeof blob.streamId !== 'number') {
    throw new Error('Blob does not reference a protocol stream')
  }

  return blob.streamId
}

export class ProtocolBlob implements ProtocolBlobInterface {
  [kBlobKey]: true = true

  public readonly source: any
  public readonly metadata: ProtocolBlobMetadata
  public readonly encode?: (metadata: ProtocolBlobMetadata) => unknown
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
    if (typeof size !== 'undefined' && (Number.isNaN(size) || size < 0))
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
    _encode?: (metadata: ProtocolBlobMetadata) => unknown,
  ) {
    let source: any
    // No type default here — source-inferred types below must win over it,
    // the default is applied last, after inference
    const metadata = { ..._metadata }

    if (_source instanceof globalThis.ReadableStream) {
      source = _source
    } else if ('File' in globalThis && _source instanceof globalThis.File) {
      source = _source.stream()
      metadata.size ??= _source.size
      metadata.filename ??= _source.name
      metadata.type ??= _source.type || undefined
    } else if (_source instanceof globalThis.Blob) {
      source = _source.stream()
      metadata.size ??= _source.size
      metadata.type ??= _source.type || undefined
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

    const resolved: ProtocolBlobMetadata = {
      ...metadata,
      type: metadata.type ?? 'application/octet-stream',
    }

    return new ProtocolBlob({
      source,
      encode: _encode?.bind(null, resolved),
      size: resolved.size,
      type: resolved.type,
      filename: resolved.filename,
    })
  }
}
