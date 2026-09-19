import type Stream from 'node:stream'

import type {
  CreditWindowOptions,
  EncodeRPCStreams,
  ProtocolBlob,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolServerStreamSink } from '@nmtjs/protocol/server'
import { noopFn } from '@nmtjs/common'
import {
  DEFAULT_BLOB_CHUNK_SIZE,
  ReceiveCreditWindow,
  STREAM_FLOW_CONTROL_VIOLATION_REASON,
} from '@nmtjs/protocol'
import {
  ProtocolClientStream,
  ProtocolServerStream,
} from '@nmtjs/protocol/server'

export const STREAM_IDLE_TIMEOUT_REASON = 'stream idle timeout'
export const STREAM_TRANSPORT_DROP_REASON =
  'transport backpressure overflow (frame dropped)'

/**
 * Node clamps larger timer delays to 1ms, which would invert a large credit
 * window into an immediate timeout.
 */
export const MAX_TIMER_DELAY = 2 ** 31 - 1

export type StreamConfig = {
  idleTimeout: number
  clientStreamWindow: CreditWindowOptions
}

/** How a local abort should treat the peer. */
export type AbortStreamOptions = {
  reason?: string
  /** False for peer-originated aborts: they must never be echoed back. */
  notifyPeer?: boolean
}

type ClientStreamState = {
  kind: 'client'
  connectionId: string
  callId: number
  stream: ProtocolClientStream
  credits: ReceiveCreditWindow
  acceptedSinceDemand: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
  // single wire-abort notification for locally-initiated aborts
  notify?: (reason: string) => void
  notified: boolean
}

type ServerStreamState = {
  kind: 'server'
  connectionId: string
  callId: number
  stream: ProtocolServerStream
  idleTimer: ReturnType<typeof setTimeout> | undefined
  pendingConsumerChunks: number
  // set for peer-originated aborts so the sink error is not echoed back
  suppressNotify: boolean
}

type StreamState = ClientStreamState | ServerStreamState

/**
 * Credit invariants:
 * - Uploads (client streams): the server grants an initial byte window and
 *   batched ClientBlobPull refills driven by consumer _read demand; the
 *   client spends them with ClientBlobPush. A push exceeding the outstanding
 *   credit is a protocol violation and aborts the stream.
 * - Downloads (server streams): the client grants byte credits with
 *   ServerBlobPull; the credit pump emits at most that many bytes.
 *   A transport-dropped frame aborts the stream (credits keep outstanding
 *   data far below the transport backpressure limit, so this is a safety
 *   net, not a flow-control mechanism).
 * - Outstanding credit is bounded by the configured upload window; peer
 *   grants beyond the protocol cap are violations.
 * - Every stream sends AT MOST one wire abort; peer-originated aborts are
 *   never echoed back.
 * - Every stream has a single idle timeout, reset on any activity in either
 *   direction; expiry aborts the stream.
 */
export class BlobStreamsManager {
  readonly clientStreams = new Map<string, ClientStreamState>()
  readonly serverStreams = new Map<string, ServerStreamState>()

  // Secondary indexes for the two sweeps: per call (abort unconsumed
  // uploads) and per connection (teardown).
  readonly connectionClientStreams = new Map<string, Set<number>>()
  readonly connectionServerStreams = new Map<string, Set<number>>()
  readonly clientCallStreams = new Map<string, Set<number>>()
  readonly serverCallStreams = new Map<string, Set<number>>()

  readonly idleTimeout: number
  readonly clientStreamWindow: CreditWindowOptions

  constructor(config: StreamConfig) {
    this.idleTimeout = config.idleTimeout
    this.clientStreamWindow = config.clientStreamWindow
  }

  // --- Client Streams (Upload) ---

  createClientStream(
    connectionId: string,
    callId: number,
    streamId: number,
    metadata: ProtocolBlobMetadata,
    options: Stream.ReadableOptions,
    notify?: (reason: string) => void,
  ) {
    const stream = new ProtocolClientStream(streamId, metadata, options)
    stream.on('error', noopFn)

    const state: ClientStreamState = {
      kind: 'client',
      connectionId,
      callId,
      stream,
      credits: new ReceiveCreditWindow(this.clientStreamWindow),
      acceptedSinceDemand: 0,
      idleTimer: undefined,
      notify,
      notified: false,
    }
    this.clientStreams.set(key(connectionId, streamId), state)
    addToIndex(this.clientCallStreams, key(connectionId, callId), streamId)
    addToIndex(this.connectionClientStreams, connectionId, streamId)

    this.touch(state)

    return stream
  }

  /** Returns the next upload grant, or zero while demand is below refill. */
  requestClientStreamCredit(connectionId: string, streamId: number) {
    const state = this.clientStreams.get(key(connectionId, streamId))
    if (!state) return 0

    const grant = state.credits.onDemand(state.acceptedSinceDemand)
    state.acceptedSinceDemand = 0
    this.touch(state)
    return grant
  }

  /** Rolls back a grant whose pull frame never made it onto the wire. */
  revokeClientStreamGrant(
    connectionId: string,
    streamId: number,
    size: number,
  ) {
    const state = this.clientStreams.get(key(connectionId, streamId))
    state?.credits.revoke(size)
  }

  /**
   * Returns `false` on a credit violation (push larger than the outstanding
   * grant, or an empty push — a free idle-timer refresh otherwise) — the
   * caller is expected to abort the stream and notify the peer.
   */
  pushToClientStream(
    connectionId: string,
    streamId: number,
    chunk: ArrayBufferView,
  ): boolean {
    const state = this.clientStreams.get(key(connectionId, streamId))
    if (!state) return true
    if (!state.credits.accept(chunk.byteLength)) return false
    state.acceptedSinceDemand = Math.min(
      state.acceptedSinceDemand + chunk.byteLength,
      state.credits.capacity,
    )
    state.stream.write(chunk)
    this.touch(state)
    return true
  }

  endClientStream(connectionId: string, streamId: number) {
    const state = this.clientStreams.get(key(connectionId, streamId))
    if (!state) return
    state.stream.end(null)
    this.removeClientStream(connectionId, streamId)
  }

  abortClientStream(
    connectionId: string,
    streamId: number,
    { reason = 'Aborted', notifyPeer = true }: AbortStreamOptions = {},
  ) {
    const state = this.clientStreams.get(key(connectionId, streamId))
    if (!state) return
    if (notifyPeer && !state.notified) {
      state.notified = true
      state.notify?.(reason)
    }
    state.stream.destroy(new Error(reason))
    this.removeClientStream(connectionId, streamId)
  }

  /** A consumed upload is the handler's to finish; drop the call's claim. */
  consumeClientStream(connectionId: string, callId: number, streamId: number) {
    removeFromIndex(this.clientCallStreams, key(connectionId, callId), streamId)
  }

  getClientCallStreamIds(connectionId: string, callId: number) {
    const streamIds = this.clientCallStreams.get(key(connectionId, callId))
    return streamIds ? Array.from(streamIds) : []
  }

  getClientStream(connectionId: string, streamId: number) {
    const state = this.clientStreams.get(key(connectionId, streamId))
    if (!state) {
      throw new Error('Stream not found')
    }

    return state.stream
  }

  private removeClientStream(connectionId: string, streamId: number) {
    const streamKey = key(connectionId, streamId)
    const state = this.clientStreams.get(streamKey)
    if (!state) return
    this.clientStreams.delete(streamKey)
    this.clearIdleTimer(state)
    removeFromIndex(
      this.clientCallStreams,
      key(connectionId, state.callId),
      streamId,
    )
    removeFromIndex(this.connectionClientStreams, connectionId, streamId)
  }

  // --- Server Streams (Download) ---

  getServerStreamsMetadata(connectionId: string, callId: number) {
    const streamIds = this.serverCallStreams.get(key(connectionId, callId))
    const streams: EncodeRPCStreams = {}

    if (streamIds) {
      for (const streamId of streamIds) {
        const state = this.serverStreams.get(key(connectionId, streamId))
        if (state) {
          streams[streamId] = state.stream.metadata
        }
      }
    }

    return streams
  }

  createServerStream(
    connectionId: string,
    callId: number,
    streamId: number,
    blob: ProtocolBlob,
    sink: ProtocolServerStreamSink,
  ) {
    const streamKey = key(connectionId, streamId)

    const stream = new ProtocolServerStream(streamId, blob, {
      chunk: (chunk) => {
        const state = this.serverStreams.get(streamKey)
        const sent = sink.chunk(chunk)
        if (sent === 'dropped') {
          this.abortServerStream(connectionId, streamId, {
            reason: STREAM_TRANSPORT_DROP_REASON,
          })
        } else if (state) {
          state.pendingConsumerChunks++
          this.touch(state, state.pendingConsumerChunks)
        }
        return sent
      },
      end: () => {
        this.removeServerStream(connectionId, streamId)
        sink.end()
      },
      error: (error) => {
        const state = this.serverStreams.get(streamKey)
        const suppress = state?.suppressNotify ?? false
        this.removeServerStream(connectionId, streamId)
        if (!suppress) sink.error(error)
      },
    })

    const state: ServerStreamState = {
      kind: 'server',
      connectionId,
      callId,
      stream,
      idleTimer: undefined,
      pendingConsumerChunks: 0,
      suppressNotify: false,
    }

    this.serverStreams.set(streamKey, state)
    addToIndex(this.serverCallStreams, key(connectionId, callId), streamId)
    addToIndex(this.connectionServerStreams, connectionId, streamId)

    this.touch(state)

    return stream
  }

  pullServerStream(connectionId: string, streamId: number, size: number) {
    const state = this.serverStreams.get(key(connectionId, streamId))
    if (!state) return
    const acknowledgedChunks = Math.ceil(size / DEFAULT_BLOB_CHUNK_SIZE)
    state.pendingConsumerChunks = Math.max(
      state.pendingConsumerChunks - acknowledgedChunks,
      0,
    )
    this.touch(state, Math.max(state.pendingConsumerChunks, 1))
    if (!state.stream.grant(size)) {
      this.abortServerStream(connectionId, streamId, {
        reason: STREAM_FLOW_CONTROL_VIOLATION_REASON,
      })
    }
  }

  abortServerStream(
    connectionId: string,
    streamId: number,
    { reason = 'Aborted', notifyPeer = true }: AbortStreamOptions = {},
  ) {
    const state = this.serverStreams.get(key(connectionId, streamId))
    if (!state) return
    if (!notifyPeer) state.suppressNotify = true
    // destroy(error) reports through the stream sink, which removes the state
    // and notifies the peer (unless suppressed) — but only while the stream
    // is still live. The explicit removal below is what clears an already
    // finished stream, whose sink will never fire again.
    state.stream.destroy(new Error(reason))
    this.removeServerStream(connectionId, streamId)
  }

  private removeServerStream(connectionId: string, streamId: number) {
    const streamKey = key(connectionId, streamId)
    const state = this.serverStreams.get(streamKey)
    if (!state) return
    this.serverStreams.delete(streamKey)
    this.clearIdleTimer(state)
    removeFromIndex(
      this.serverCallStreams,
      key(connectionId, state.callId),
      streamId,
    )
    removeFromIndex(this.connectionServerStreams, connectionId, streamId)
  }

  // --- Idle timeout ---

  private touch(state: StreamState, timeoutMultiplier = 1) {
    this.clearIdleTimer(state)
    const { kind, connectionId, stream } = state
    state.idleTimer = setTimeout(
      () => {
        state.idleTimer = undefined
        const options = { reason: STREAM_IDLE_TIMEOUT_REASON }
        if (kind === 'client') {
          this.abortClientStream(connectionId, stream.id, options)
        } else {
          this.abortServerStream(connectionId, stream.id, options)
        }
      },
      Math.min(this.idleTimeout * timeoutMultiplier, MAX_TIMER_DELAY),
    )
  }

  private clearIdleTimer(state: StreamState) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer)
      state.idleTimer = undefined
    }
  }

  // --- Cleanup ---

  abortClientCallStreams(
    connectionId: string,
    callId: number,
    reason = 'Call aborted',
  ) {
    const streamIds = this.clientCallStreams.get(key(connectionId, callId))
    if (!streamIds) return
    for (const streamId of Array.from(streamIds)) {
      this.abortClientStream(connectionId, streamId, { reason })
    }
  }

  cleanupConnection(connectionId: string) {
    // the connection is being torn down: peer notifications go nowhere
    const options = { reason: 'Connection closed', notifyPeer: false }

    const clientStreamIds = this.connectionClientStreams.get(connectionId)
    if (clientStreamIds) {
      for (const streamId of Array.from(clientStreamIds)) {
        this.abortClientStream(connectionId, streamId, options)
      }
    }

    const serverStreamIds = this.connectionServerStreams.get(connectionId)
    if (serverStreamIds) {
      for (const streamId of Array.from(serverStreamIds)) {
        this.abortServerStream(connectionId, streamId, options)
      }
    }
  }
}

const key = (connectionId: string, id: number) => `${connectionId}:${id}`

function addToIndex(
  index: Map<string, Set<number>>,
  indexKey: string,
  id: number,
) {
  let ids = index.get(indexKey)
  if (!ids) {
    ids = new Set()
    index.set(indexKey, ids)
  }
  ids.add(id)
}

function removeFromIndex(
  index: Map<string, Set<number>>,
  indexKey: string,
  id: number,
) {
  const ids = index.get(indexKey)
  if (!ids) return
  ids.delete(id)
  if (ids.size === 0) index.delete(indexKey)
}
