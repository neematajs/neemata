import type { ProtocolFormats } from './format.ts'
import type { ResolveFormatParams } from './types.ts'

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
