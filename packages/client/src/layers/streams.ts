import type {
  ProtocolBlob,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolClientBlobStream } from '@nmtjs/protocol/client'
import { MAX_UINT32, noopFn } from '@nmtjs/common'
import {
  ClientMessageType,
  createProtocolBlobReference,
  getProtocolBlobStreamId,
  ServerMessageType,
} from '@nmtjs/protocol'
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
  createServerBlob: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolBlobInterface
  addServerBlobStream: (
    metadata: ProtocolBlobMetadata,
    options?: {
      start?: (
        stream: ProtocolServerBlobStream,
        options?: { signal?: AbortSignal },
      ) => void
    },
  ) => {
    blob: ProtocolBlobInterface
    streamId: number
    stream: ProtocolServerBlobStream
  }
  consumeServerBlob: (
    blob: ProtocolBlobInterface,
    options?: { signal?: AbortSignal },
  ) => ProtocolServerBlobStream
}

export const createStreamLayer = (core: ClientCore): StreamLayerApi => {
  const clientStreams = new ClientStreams()
  const serverStreams = new ServerStreams<ProtocolServerBlobStream>()
  const serverBlobInitializers = new Map<
    number,
    (options?: { signal?: AbortSignal }) => void
  >()

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

  const abortServerBlob = (streamId: number, reason?: unknown) => {
    if (core.messageContext) {
      core.emitStreamEvent({
        direction: 'outgoing',
        streamType: 'server_blob',
        action: 'abort',
        streamId,
        reason: toReasonString(reason),
      })

      const buffer = core.protocol.encodeMessage(
        core.messageContext,
        ClientMessageType.ServerStreamAbort,
        { streamId, reason: toReasonString(reason) },
      )

      core.send(buffer).catch(noopFn)
    }

    void serverStreams.abort(streamId).catch(noopFn)
  }

  const createServerBlob = (id: number, metadata: ProtocolBlobMetadata) => {
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
        serverBlobInitializers.delete(id)
        serverStreams.remove(id)
      },
      readableStrategy: { highWaterMark: 0 },
    })

    serverStreams.add(id, stream)

    return createProtocolBlobReference(id, metadata)
  }

  const addServerBlobStream = (
    metadata: ProtocolBlobMetadata,
    options?: {
      start?: (
        stream: ProtocolServerBlobStream,
        options?: { signal?: AbortSignal },
      ) => void
    },
  ) => {
    const id = getStreamId()
    const stream = new ProtocolServerBlobStream(metadata)
    serverStreams.add(id, stream)

    if (options?.start) {
      let started = false
      serverBlobInitializers.set(id, (subscriptionOptions) => {
        if (started) return
        started = true
        options.start?.(stream, subscriptionOptions)
      })
    }

    return {
      blob: createProtocolBlobReference(id, metadata),
      streamId: id,
      stream,
    }
  }

  const consumeServerBlob = (
    blob: ProtocolBlobInterface,
    options?: { signal?: AbortSignal },
  ) => {
    const id = getProtocolBlobStreamId(blob)
    const stream = serverStreams.get(id)

    if (options?.signal?.aborted) {
      abortServerBlob(id, options.signal.reason)
      return stream
    }

    if (options?.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          abortServerBlob(id, options.signal?.reason)
        },
        { once: true },
      )
    }

    serverBlobInitializers.get(id)?.(options)
    serverBlobInitializers.delete(id)

    return stream
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
        serverBlobInitializers.delete(message.streamId)
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'end',
          streamId: message.streamId,
        })
        void serverStreams.end(message.streamId)
        break
      case ServerMessageType.ServerStreamAbort:
        serverBlobInitializers.delete(message.streamId)
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
    serverBlobInitializers.clear()
  })

  return {
    clientStreams,
    serverStreams,
    getStreamId,
    addClientStream,
    createServerBlob,
    addServerBlobStream,
    consumeServerBlob,
  }
}
