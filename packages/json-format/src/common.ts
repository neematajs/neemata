import type { UpStream } from '@neematajs/common'

const STREAM_SERIALIZE_KEY = '__neemata:stream:'

export const serializeStreamId = (stream: UpStream) => {
  return STREAM_SERIALIZE_KEY + stream.id
}

export const isStreamId = (value: any) => {
  return (
    value && typeof value === 'string' && value.startsWith(STREAM_SERIALIZE_KEY)
  )
}

export const deserializeStreamId = (value: string) => {
  const streamId = value.slice(STREAM_SERIALIZE_KEY.length)
  return Number.parseInt(streamId)
}
