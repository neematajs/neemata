import type { ProtocolFormats } from './format.ts'
import type { ResolveFormatParams } from './types.ts'

export class UnsupportedFormatError extends Error {}

export class UnsupportedContentTypeError extends UnsupportedFormatError {}

export class UnsupportedAcceptTypeError extends UnsupportedFormatError {}

export const getFormat = (
  format: ProtocolFormats,
  { accept, contentType }: ResolveFormatParams,
) => {
  const encoder = accept ? format.supportsEncoder(accept) : undefined
  if (!encoder) throw new UnsupportedAcceptTypeError('Unsupported Accept type')

  const decoder = contentType ? format.supportsDecoder(contentType) : undefined
  if (!decoder)
    throw new UnsupportedContentTypeError('Unsupported Content type')

  return { encoder, decoder }
}
