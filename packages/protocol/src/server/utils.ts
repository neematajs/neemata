import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  ProtocolFormats,
} from './format.ts'
import type { ProtocolVersionInterface } from './protocol.ts'
import type { ProtocolClientStream, ProtocolServerStream } from './stream.ts'

export type ResolveFormatParams = {
  contentType?: string | null
  accept?: string | null
}

export class UnsupportedFormatError extends Error {}

export class UnsupportedContentTypeError extends UnsupportedFormatError {}

export class UnsupportedAcceptTypeError extends UnsupportedFormatError {}

export const getFormat = (
  format: ProtocolFormats,
  { accept, contentType }: ResolveFormatParams,
) => {
  const encoder = contentType ? format.supportsEncoder(contentType) : undefined
  if (!encoder)
    throw new UnsupportedContentTypeError('Unsupported Content type')

  const decoder = accept ? format.supportsDecoder(accept) : undefined
  if (!decoder) throw new UnsupportedAcceptTypeError('Unsupported Accept type')

  return { encoder, decoder }
}

export type MessageContext = {
  protocol: ProtocolVersionInterface
  connectionId: string
  streamId: () => number
  decoder: BaseServerDecoder
  encoder: BaseServerEncoder
  addClientStream: (options: {
    streamId: number
    callId: number
    metadata: ProtocolBlobMetadata
    // pull: (size: number) => any
  }) => () => ProtocolClientStream
  addServerStream: (options: {
    streamId: number
    callId: number
    blob: ProtocolBlob
  }) => ProtocolServerStream
  transport: {
    send?: (connectionId: string, buffer: ArrayBufferView) => boolean | null
  }
}
