import type { ProtocolFormat } from './format.ts'

export type ResolveFormatParams = {
  contentType?: string | null
  acceptType?: string | null
}

export class UnsupportedFormatError extends Error {}

export class UnsupportedContentTypeError extends UnsupportedFormatError {}

export class UnsupportedAcceptTypeError extends UnsupportedFormatError {}

export const getFormat = (
  format: ProtocolFormat,
  { acceptType, contentType }: ResolveFormatParams,
) => {
  const encoder = contentType ? format.supportsEncoder(contentType) : undefined
  if (!encoder)
    throw new UnsupportedContentTypeError('Unsupported Content-Type')

  const decoder = acceptType ? format.supportsDecoder(acceptType) : undefined
  if (!decoder) throw new UnsupportedAcceptTypeError('Unsupported Accept-Type')

  return { encoder, decoder }
}
