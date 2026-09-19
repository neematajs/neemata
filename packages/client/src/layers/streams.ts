import type {
  ProtocolBlob,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolClientBlobStream } from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
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
import { ClientStreams, ServerStreams } from '../stream-registry.ts'
import { createIdCounter, toReasonString } from '../utils.ts'

type ClientBlobUpload = {
  credits: SendCredits
  pumping: boolean
}

export interface StreamLayerApi {
  readonly clientStreams: ClientStreams
  readonly serverStreams: ServerStreams
  nextStreamId: () => number
  addClientStream: (blob: ProtocolBlob) => ProtocolClientBlobStream
  createServerBlob: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolBlobInterface
  addServerBlobStream: (
    metadata: ProtocolBlobMetadata,
    source: ReadableStream<ArrayBufferView>,
  ) => ProtocolBlobInterface
  consumeServerBlob: (
    blob: ProtocolBlobInterface,
    options?: { signal?: AbortSignal },
  ) => ProtocolServerBlobStream
}

export const createStreamLayer = (core: ClientCore): StreamLayerApi => {
  const clientStreams = new ClientStreams()
  const clientBlobUploads = new Map<number, ClientBlobUpload>()
  const serverStreams = new ServerStreams<ProtocolServerBlobStream>()
  const serverBlobDownloads = new Map<number, ReceiveCreditWindow>()
  const serverBlobInitializers = new Map<
    number,
    (options?: { signal?: AbortSignal }) => void
  >()

  const nextStreamId = createIdCounter()

  const addClientStream = (blob: ProtocolBlob) => {
    const id = nextStreamId()
    const stream = clientStreams.add(blob.source, id, blob.metadata)
    clientBlobUploads.set(id, {
      credits: new SendCredits(),
      pumping: false,
    })
    return stream
  }

  const abortClientBlobUpload = async (
    streamId: number,
    upload: ClientBlobUpload,
    reason?: unknown,
  ) => {
    if (clientBlobUploads.get(streamId) !== upload) return
    clientBlobUploads.delete(streamId)
    const reasonString = toReasonString(reason)

    core.emitStreamEvent({
      direction: 'outgoing',
      streamType: 'client_blob',
      action: 'abort',
      streamId,
      reason: reasonString,
    })

    await core
      .sendMessage(ClientMessageType.ClientBlobAbort, {
        streamId,
        reason: reasonString,
      })
      ?.catch(noopFn)

    await clientStreams.abort(streamId, reason).catch(noopFn)
  }

  const pumpClientBlobUpload = async (
    streamId: number,
    upload: ClientBlobUpload,
  ) => {
    if (upload.pumping) return
    upload.pumping = true

    try {
      while (
        clientBlobUploads.get(streamId) === upload &&
        upload.credits.available > 0
      ) {
        const chunk = await clientStreams.pull(
          streamId,
          Math.min(upload.credits.available, DEFAULT_BLOB_CHUNK_SIZE),
        )

        // Cancellation can settle a pending read with done=true. Recheck
        // ownership so a peer abort or disconnect cannot turn into End.
        if (clientBlobUploads.get(streamId) !== upload) return

        if (!chunk) {
          clientBlobUploads.delete(streamId)

          core.emitStreamEvent({
            direction: 'outgoing',
            streamType: 'client_blob',
            action: 'end',
            streamId,
          })

          await core
            .sendMessage(ClientMessageType.ClientBlobEnd, { streamId })
            ?.catch(noopFn)

          await clientStreams.end(streamId).catch(noopFn)
          return
        }

        if (chunk.byteLength === 0) {
          continue
        }

        if (!upload.credits.spend(chunk.byteLength)) {
          throw new Error('Client blob upload exceeded granted credit')
        }

        core.emitStreamEvent({
          direction: 'outgoing',
          streamType: 'client_blob',
          action: 'push',
          streamId,
          byteLength: chunk.byteLength,
        })

        const sent = core.sendMessage(ClientMessageType.ClientBlobPush, {
          streamId,
          chunk,
        })
        if (!sent) throw new Error('Client disconnected during blob upload')
        await sent
      }
    } catch (error) {
      await abortClientBlobUpload(streamId, upload, error)
    } finally {
      upload.pumping = false
    }
  }

  const abortServerBlob = (streamId: number, reason?: unknown) => {
    serverBlobDownloads.delete(streamId)

    if (core.messageContext) {
      const reasonString = toReasonString(reason)

      core.emitStreamEvent({
        direction: 'outgoing',
        streamType: 'server_blob',
        action: 'abort',
        streamId,
        reason: reasonString,
      })

      core
        .sendMessage(ClientMessageType.ServerBlobAbort, {
          streamId,
          reason: reasonString,
        })
        ?.catch(noopFn)
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

        core
          .sendMessage(ClientMessageType.ServerBlobPull, {
            streamId: id,
            size: grant,
          })
          ?.catch((error) => {
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
    source: ReadableStream<ArrayBufferView>,
  ) => {
    const id = nextStreamId()
    serverStreams.add(id, new ProtocolServerBlobStream(metadata))

    // forwarding starts on consumption: the blob may never be read
    serverBlobInitializers.set(id, (options) => {
      forwardServerBlobSource(id, source, options?.signal).catch(noopFn)
    })

    return createProtocolBlobReference(id, metadata)
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

  core.on('message', (message) => {
    switch (message.type) {
      case ServerMessageType.ServerBlobPush: {
        const { streamId, chunk } = message
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'server_blob',
          action: 'push',
          streamId,
          byteLength: chunk.byteLength,
        })

        const credits = serverBlobDownloads.get(streamId)
        if (!credits) break
        if (!credits.accept(chunk.byteLength)) {
          abortServerBlob(streamId, STREAM_FLOW_CONTROL_VIOLATION_REASON)
          break
        }
        // not awaited: the writable queue keeps per-stream arrival order and
        // awaiting would stall other streams' messages; a failed push aborts
        // the stream on both sides instead of leaking a rejection
        serverStreams.push(streamId, chunk).catch((error) => {
          if (!serverStreams.has(streamId)) return
          abortServerBlob(streamId, error)
        })
        break
      }
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
      case ServerMessageType.ClientBlobPull: {
        const { streamId, size } = message
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'client_blob',
          action: 'pull',
          streamId,
          byteLength: size,
        })

        const upload = clientBlobUploads.get(streamId)
        if (!upload) break
        if (!upload.credits.grant(size)) {
          abortClientBlobUpload(
            streamId,
            upload,
            STREAM_FLOW_CONTROL_VIOLATION_REASON,
          ).catch(noopFn)
          break
        }

        pumpClientBlobUpload(streamId, upload).catch(noopFn)
        break
      }
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
    nextStreamId,
    addClientStream,
    createServerBlob,
    addServerBlobStream,
    consumeServerBlob,
  }
}
