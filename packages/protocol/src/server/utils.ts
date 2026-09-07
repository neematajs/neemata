import type { ProtocolCodecRegistry } from './codec.ts'
import type { ResolveCodecParams } from './types.ts'

export class CodecNegotiationError extends Error {}

export class UnsupportedContentTypeError extends CodecNegotiationError {}

export class UnsupportedAcceptTypeError extends CodecNegotiationError {}

export const negotiateCodecs = (
  codecs: ProtocolCodecRegistry,
  { accept, contentType }: ResolveCodecParams,
) => {
  const encoder = accept ? codecs.supportsEncoder(accept) : undefined
  if (!encoder) throw new UnsupportedAcceptTypeError('Unsupported Accept type')

  const decoder = contentType ? codecs.supportsDecoder(contentType) : undefined
  if (!decoder)
    throw new UnsupportedContentTypeError('Unsupported Content type')

  return { encoder, decoder }
}
