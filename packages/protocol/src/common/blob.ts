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
      metadata: { enumerable: true, value: metadata },
      streamId: { value: streamId },
      [kBlobKey]: { value: true },
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
    encode?: (metadata: ProtocolBlobMetadata) => unknown
    size?: number
    type?: string
    filename?: string
  }) {
    if (size !== undefined && (Number.isNaN(size) || size < 0))
      throw new Error('Blob size is invalid')

    this.encode = encode
    this.source = source
    this.metadata = { size, type, filename }
    if (encode) {
      Object.defineProperty(this, 'toJSON', { value: encode })
    }
  }

  static from(
    input: any,
    metadata: { size?: number; type?: string; filename?: string } = {},
    encode?: (metadata: ProtocolBlobMetadata) => unknown,
  ) {
    // No type default here — source-inferred types below must win over it,
    // the default is applied last, after inference
    const inferred = { ...metadata }
    let source: any
    let blob: Blob | undefined

    if (input instanceof globalThis.ReadableStream) {
      source = input
    } else if ('File' in globalThis && input instanceof globalThis.File) {
      source = input.stream()
      inferred.size ??= input.size
      inferred.filename ??= input.name
      inferred.type ??= input.type || undefined
    } else if (input instanceof globalThis.Blob) {
      source = input.stream()
      inferred.size ??= input.size
      inferred.type ??= input.type || undefined
    } else if (typeof input === 'string') {
      blob = new Blob([input])
      inferred.type ??= 'text/plain'
    } else if (globalThis.ArrayBuffer.isView(input)) {
      blob = new Blob([input as ArrayBufferView<ArrayBuffer>])
    } else if (input instanceof globalThis.ArrayBuffer) {
      blob = new Blob([input])
    } else {
      source = input
    }

    if (blob) {
      source = blob.stream()
      inferred.size ??= blob.size
    }

    const resolved: ProtocolBlobMetadata = {
      ...inferred,
      type: inferred.type ?? 'application/octet-stream',
    }

    return new ProtocolBlob({
      source,
      encode: encode?.bind(null, resolved),
      size: resolved.size,
      type: resolved.type,
      filename: resolved.filename,
    })
  }
}
