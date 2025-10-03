import type { BaseProtocolError, ProtocolBlobMetadata } from '@nmtjs/protocol'

// TODO: is this a good way to serialize streams within json?
const STREAM_SERIALIZE_KEY = '%neemata:stream:%\f'

export const serializeStreamId = (id: number) => {
  return `${STREAM_SERIALIZE_KEY}${id}`
}

export const deserializeStreamId = (value: string) => {
  const streamId = value.slice(STREAM_SERIALIZE_KEY.length)
  return Number.parseInt(streamId)
}

export const isStreamId = (value: any) => {
  return (
    typeof value === 'string' &&
    value.length &&
    value.startsWith(STREAM_SERIALIZE_KEY)
  )
}

export type StreamsMetadata = Record<number, ProtocolBlobMetadata>

export type ClientEncodedRPC = [
  callId: number,
  procedure: string,
  streams: StreamsMetadata,
  payload?: any,
]

export type ServerEncodedRPC =
  | [callId: number, error: BaseProtocolError]
  | [callId: number, error: null, streams: StreamsMetadata, payload?: any]
