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
  DEFAULT_BLOB_CHUNK_SIZE,
  DEFAULT_BLOB_CREDIT_REFILL,
  DEFAULT_BLOB_CREDIT_WINDOW,
  getProtocolBlobStreamId,
  ReceiveCreditWindow,
  SendCredits,
  ServerMessageType,
  STREAM_FLOW_CONTROL_VIOLATION_REASON,
} from '@nmtjs/protocol'
import { ProtocolServerBlobStream } from '@nmtjs/protocol/client'

import type { ClientCore } from '../core.ts'
import { ClientStreams, ServerStreams } from '../streams.ts'

type ClientBlobUploadState = {
  credits: SendCredits
  pumping: boolean
}

export const toReasonString = (reason: unknown) => {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return undefined
  if (reason instanceof Error) return reason.message
  try {
    // JSON.stringify returns undefined (does not throw) for symbols/functions
    const json = JSON.stringify(reason)
    if (json !== undefined) return json
  } catch {}
  if (
    typeof reason === 'number' ||
    typeof reason === 'boolean' ||
    typeof reason === 'bigint' ||
    typeof reason === 'symbol'
  ) {
    return reason.toString()
  }
  return Object.prototype.toString.call(reason)
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
      source?: ReadableStream<ArrayBufferView>
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
  const clientBlobUploads = new Map<number, ClientBlobUploadState>()
  const serverStreams = new ServerStreams<ProtocolServerBlobStream>()
  const serverBlobDownloads = new Map<number, ReceiveCreditWindow>()
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
    const stream = clientStreams.add(blob.source, id, blob.metadata)
    clientBlobUploads.set(id, {
      credits: new SendCredits(),
      pumping: false,
    })
    return stream
  }

  const abortClientBlobUpload = async (
    streamId: number,
    state: ClientBlobUploadState,
    reason?: unknown,
  ) => {
    if (clientBlobUploads.get(streamId) !== state) return
    clientBlobUploads.delete(streamId)
    const reasonString = toReasonString(reason)

    core.emitStreamEvent({
      direction: 'outgoing',
      streamType: 'client_blob',
      action: 'abort',
      streamId,
      reason: reasonString,
    })

    if (core.messageContext) {
      const buffer = core.protocol.encodeMessage(
        core.messageContext,
        ClientMessageType.ClientBlobAbort,
        { streamId, reason: reasonString },
      )
      await core.send(buffer).catch(noopFn)
    }

    await clientStreams.abort(streamId, reason).catch(noopFn)
  }

  const pumpClientBlobUpload = async (
    streamId: number,
    state: ClientBlobUploadState,
  ) => {
    if (state.pumping) return
    state.pumping = true

    try {
      while (
        clientBlobUploads.get(streamId) === state &&
        state.credits.available > 0
      ) {
        const chunk = await clientStreams.pull(
          streamId,
          Math.min(state.credits.available, DEFAULT_BLOB_CHUNK_SIZE),
        )

        // Cancellation can settle a pending read with done=true. Recheck
        // ownership so a peer abort or disconnect cannot turn into End.
        if (clientBlobUploads.get(streamId) !== state) return

        if (!chunk) {
          clientBlobUploads.delete(streamId)

          core.emitStreamEvent({
            direction: 'outgoing',
            streamType: 'client_blob',
            action: 'end',
            streamId,
          })

          if (core.messageContext) {
            const buffer = core.protocol.encodeMessage(
              core.messageContext,
              ClientMessageType.ClientBlobEnd,
              { streamId },
            )
            await core.send(buffer).catch(noopFn)
          }

          await clientStreams.end(streamId).catch(noopFn)
          return
        }

        if (chunk.byteLength === 0) {
          continue
        }

        if (!state.credits.spend(chunk.byteLength)) {
          throw new Error('Client blob upload exceeded granted credit')
        }

        core.emitStreamEvent({
          direction: 'outgoing',
          streamType: 'client_blob',
          action: 'push',
          streamId,
          byteLength: chunk.byteLength,
        })

        if (!core.messageContext) {
          throw new Error('Client disconnected during blob upload')
        }
        const buffer = core.protocol.encodeMessage(
          core.messageContext,
          ClientMessageType.ClientBlobPush,
          { streamId, chunk },
        )
        await core.send(buffer)
      }
    } catch (error) {
      await abortClientBlobUpload(streamId, state, error)
    } finally {
      state.pumping = false
    }
  }

  const abortServerBlob = (streamId: number, reason?: unknown) => {
    serverBlobDownloads.delete(streamId)

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
        ClientMessageType.ServerBlobAbort,
        { streamId, reason: toReasonString(reason) },
      )

      core.send(buffer).catch(noopFn)
    }

    void serverStreams.abort(streamId, reason).catch(noopFn)
  }

  const createServerBlob = (id: number, metadata: ProtocolBlobMetadata) => {
    const credits = new ReceiveCreditWindow({
      capacity: DEFAULT_BLOB_CREDIT_WINDOW,
      refill: DEFAULT_BLOB_CREDIT_REFILL,
    })

    const stream = new ProtocolServerBlobStream(metadata, {
      pull: (_controller, consumed) => {
        if (!core.messageContext) return

        const grant = credits.onDemand(consumed?.byteLength ?? 0)
        if (grant === 0) return

        core.emitStreamEvent({
          direction: 'outgoing',
          streamType: 'server_blob',
          action: 'pull',
          streamId: id,
          byteLength: grant,
        })

        const buffer = core.protocol.encodeMessage(
          core.messageContext,
          ClientMessageType.ServerBlobPull,
          { streamId: id, size: grant },
        )

        core.send(buffer).catch((error) => {
          credits.revoke(grant)
          if (serverStreams.has(id)) abortServerBlob(id, error)
        })
      },
      close: () => {
        serverBlobInitializers.delete(id)
        serverBlobDownloads.delete(id)
        serverStreams.remove(id)
      },
      readableStrategy: { highWaterMark: 0 },
    })

    serverStreams.add(id, stream)
    serverBlobDownloads.set(id, credits)

    return createProtocolBlobReference(id, metadata)
  }

  const addServerBlobStream = (
    metadata: ProtocolBlobMetadata,
    options?: {
      source?: ReadableStream<ArrayBufferView>
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
    } else if (options?.source) {
      const source = options.source
      let started = false
      serverBlobInitializers.set(id, (subscriptionOptions) => {
        if (started) return
        started = true
        forwardServerBlobSource(id, source, subscriptionOptions?.signal).catch(
          noopFn,
        )
      })
    }

    return {
      blob: createProtocolBlobReference(id, metadata),
      streamId: id,
      stream,
    }
  }

  const forwardServerBlobSource = async (
    streamId: number,
    source: ReadableStream<ArrayBufferView>,
    signal?: AbortSignal,
  ) => {
    try {
      signal?.throwIfAborted()

      for await (const chunk of source) {
        signal?.throwIfAborted()
        await serverStreams.push(streamId, chunk)
      }

      await serverStreams.end(streamId)
    } catch (error) {
      await serverStreams.abort(streamId, error).catch(noopFn)
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
      case ServerMessageType.ServerBlobPush:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'push',
          streamId: message.streamId,
          byteLength: message.chunk.byteLength,
        })

        {
          const credits = serverBlobDownloads.get(message.streamId)
          if (!credits) break
          if (!credits.accept(message.chunk.byteLength)) {
            abortServerBlob(
              message.streamId,
              STREAM_FLOW_CONTROL_VIOLATION_REASON,
            )
            break
          }
        }
        // not awaited: the writable queue keeps per-stream arrival order and
        // awaiting would stall other streams' messages; a failed push aborts
        // the stream on both sides instead of leaking a rejection
        serverStreams.push(message.streamId, message.chunk).catch((error) => {
          if (!serverStreams.has(message.streamId)) return
          abortServerBlob(message.streamId, error)
        })
        break
      case ServerMessageType.ServerBlobEnd:
        serverBlobInitializers.delete(message.streamId)
        serverBlobDownloads.delete(message.streamId)
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'end',
          streamId: message.streamId,
        })
        void serverStreams.end(message.streamId).catch(noopFn)
        break
      case ServerMessageType.ServerBlobAbort:
        serverBlobInitializers.delete(message.streamId)
        serverBlobDownloads.delete(message.streamId)
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'abort',
          streamId: message.streamId,
          reason: message.reason,
        })
        void serverStreams.abort(message.streamId, message.reason).catch(noopFn)
        break
      case ServerMessageType.ClientBlobPull:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'client_blob',
          action: 'pull',
          streamId: message.streamId,
          byteLength: message.size,
        })

        {
          const state = clientBlobUploads.get(message.streamId)
          if (!state) break
          if (!state.credits.grant(message.size)) {
            abortClientBlobUpload(
              message.streamId,
              state,
              STREAM_FLOW_CONTROL_VIOLATION_REASON,
            ).catch(noopFn)
            break
          }

          pumpClientBlobUpload(message.streamId, state).catch(noopFn)
        }
        break
      case ServerMessageType.ClientBlobAbort:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'client_blob',
          action: 'abort',
          streamId: message.streamId,
          reason: message.reason,
        })
        clientBlobUploads.delete(message.streamId)
        void clientStreams.abort(message.streamId, message.reason).catch(noopFn)
        break
    }
  })

  core.on('disconnected', (reason) => {
    clientBlobUploads.clear()
    serverBlobDownloads.clear()
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
