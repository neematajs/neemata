import type { Format } from './format.ts'

export type ResolveFormatParams = {
  contentType?: string | null
  acceptType?: string | null
}

export const getFormat = (
  format: Format,
  { acceptType, contentType }: ResolveFormatParams,
) => {
  const encoder = contentType ? format.supportsEncoder(contentType) : undefined
  if (!encoder) throw new Error('Unsupported content-type')

  const decoder = acceptType ? format.supportsDecoder(acceptType) : undefined
  if (!decoder) throw new Error('Unsupported accept')

  return {
    encoder,
    decoder,
  }
}
