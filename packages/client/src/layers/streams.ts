import type { ProtocolBlob, ProtocolBlobMetadata } from '@nmtjs/protocol'
import type {
  ProtocolClientBlobStream,
  ProtocolServerBlobConsumer,
} from '@nmtjs/protocol/client'
import { MAX_UINT32, noopFn } from '@nmtjs/common'
import { ClientMessageType, kBlobKey, ServerMessageType } from '@nmtjs/protocol'
import { ProtocolServerBlobStream } from '@nmtjs/protocol/client'

import type { ClientCore } from '../core.ts'
import { ClientStreams, ServerStreams } from '../streams.ts'

const DEFAULT_PULL_SIZE = 65535

const toReasonString = (reason: unknown) => {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return undefined
  return String(reason)
}

export interface StreamLayerApi {
  readonly clientStreams: ClientStreams
  readonly serverStreams: ServerStreams
  getStreamId: () => number
  addClientStream: (blob: ProtocolBlob) => ProtocolClientBlobStream
  createServerBlobStream: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolServerBlobConsumer
  addServerBlobStream: (metadata: ProtocolBlobMetadata) => {
    streamId: number
    stream: ProtocolServerBlobStream
  }
}

export const createServerBlobConsumer = (
  metadata: ProtocolBlobMetadata,
  subscribe: (options?: { signal?: AbortSignal }) => ProtocolServerBlobStream,
): ProtocolServerBlobConsumer => {
  const consumer = ((options?: { signal?: AbortSignal }) =>
    subscribe(options)) as ProtocolServerBlobConsumer

  Object.defineProperties(consumer, {
    metadata: {
      configurable: false,
      enumerable: true,
      writable: false,
      value: metadata,
    },
    [kBlobKey]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    },
  })

  return consumer
}

export const createStreamLayer = (core: ClientCore): StreamLayerApi => {
  const clientStreams = new ClientStreams()
  const serverStreams = new ServerStreams()

  let streamId = 0

  const getStreamId = () => {
    if (streamId >= MAX_UINT32) {
      streamId = 0
    }

    return streamId++
  }

  const addClientStream = (blob: ProtocolBlob) => {
    const id = getStreamId()
    return clientStreams.add(blob.source, id, blob.metadata)
  }

  const createServerBlobStream = (
    id: number,
    metadata: ProtocolBlobMetadata,
  ) => {
    const stream = new ProtocolServerBlobStream(metadata, {
      pull: () => {
        if (!core.messageContext) return

        core.emitStreamEvent({
          direction: 'outgoing',
          streamType: 'server_blob',
          action: 'pull',
          streamId: id,
          byteLength: DEFAULT_PULL_SIZE,
        })

        const buffer = core.protocol.encodeMessage(
          core.messageContext,
          ClientMessageType.ServerStreamPull,
          { streamId: id, size: DEFAULT_PULL_SIZE },
        )

        core.send(buffer).catch(noopFn)
      },
      close: () => {
        serverStreams.remove(id)
      },
      readableStrategy: { highWaterMark: 0 },
    })

    serverStreams.add(id, stream)

    return createServerBlobConsumer(metadata, ({ signal } = {}) => {
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (!core.messageContext) return

            core.emitStreamEvent({
              direction: 'outgoing',
              streamType: 'server_blob',
              action: 'abort',
              streamId: id,
              reason: toReasonString(signal.reason),
            })

            const buffer = core.protocol.encodeMessage(
              core.messageContext,
              ClientMessageType.ServerStreamAbort,
              { streamId: id, reason: toReasonString(signal.reason) },
            )

            core.send(buffer).catch(noopFn)
            void serverStreams.abort(id).catch(noopFn)
          },
          { once: true },
        )
      }

      return stream
    })
  }

  const addServerBlobStream = (metadata: ProtocolBlobMetadata) => {
    const id = getStreamId()
    const stream = new ProtocolServerBlobStream(metadata)
    serverStreams.add(id, stream)
    return { streamId: id, stream }
  }

  core.on('message', (message: any) => {
    switch (message.type) {
      case ServerMessageType.ServerStreamPush:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'push',
          streamId: message.streamId,
          byteLength: message.chunk.byteLength,
        })
        void serverStreams.push(message.streamId, message.chunk)
        break
      case ServerMessageType.ServerStreamEnd:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'end',
          streamId: message.streamId,
        })
        void serverStreams.end(message.streamId)
        break
      case ServerMessageType.ServerStreamAbort:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'abort',
          streamId: message.streamId,
          reason: message.reason,
        })
        void serverStreams.abort(message.streamId)
        break
      case ServerMessageType.ClientStreamPull:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'client_blob',
          action: 'pull',
          streamId: message.streamId,
          byteLength: message.size,
        })

        void clientStreams.pull(message.streamId, message.size).then(
          (chunk) => {
            if (!core.messageContext) return

            if (chunk) {
              core.emitStreamEvent({
                direction: 'outgoing',
                streamType: 'client_blob',
                action: 'push',
                streamId: message.streamId,
                byteLength: chunk.byteLength,
              })

              const buffer = core.protocol.encodeMessage(
                core.messageContext,
                ClientMessageType.ClientStreamPush,
                { streamId: message.streamId, chunk },
              )

              core.send(buffer).catch(noopFn)
              return
            }

            core.emitStreamEvent({
              direction: 'outgoing',
              streamType: 'client_blob',
              action: 'end',
              streamId: message.streamId,
            })

            const buffer = core.protocol.encodeMessage(
              core.messageContext,
              ClientMessageType.ClientStreamEnd,
              { streamId: message.streamId },
            )

            core.send(buffer).catch(noopFn)
            void clientStreams.end(message.streamId).catch(noopFn)
          },
          () => {
            if (!core.messageContext) return

            core.emitStreamEvent({
              direction: 'outgoing',
              streamType: 'client_blob',
              action: 'abort',
              streamId: message.streamId,
            })

            const buffer = core.protocol.encodeMessage(
              core.messageContext,
              ClientMessageType.ClientStreamAbort,
              { streamId: message.streamId },
            )

            core.send(buffer).catch(noopFn)
            clientStreams.remove(message.streamId)
          },
        )
        break
      case ServerMessageType.ClientStreamAbort:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'client_blob',
          action: 'abort',
          streamId: message.streamId,
          reason: message.reason,
        })
        void clientStreams.abort(message.streamId, message.reason).catch(noopFn)
        break
    }
  })

  core.on('disconnected', (reason) => {
    void clientStreams.clear(reason).catch(noopFn)
    void serverStreams.clear(reason).catch(noopFn)
  })

  return {
    clientStreams,
    serverStreams,
    getStreamId,
    addClientStream,
    createServerBlobStream,
    addServerBlobStream,
  }
}
