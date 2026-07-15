import type Stream from 'node:stream'

import type {
  EncodeRPCStreams,
  ProtocolBlob,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolServerStreamSink } from '@nmtjs/protocol/server'
import { noopFn } from '@nmtjs/common'
import {
  ProtocolClientStream,
  ProtocolServerStream,
} from '@nmtjs/protocol/server'

export const STREAM_IDLE_TIMEOUT_REASON = 'stream idle timeout'
export const STREAM_CREDIT_VIOLATION_REASON = 'stream credit violation'
export const STREAM_TRANSPORT_DROP_REASON =
  'transport backpressure overflow (frame dropped)'

export type StreamConfig = {
  idleTimeout: number
}

type ClientStreamState = {
  connectionId: string
  callId: number
  stream: ProtocolClientStream
  // outstanding byte credit: incremented per pull sent, decremented per push
  granted: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

type ServerStreamState = {
  connectionId: string
  callId: number
  stream: ProtocolServerStream
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

type StreamState = ClientStreamState | ServerStreamState

/**
 * Credit invariants:
 * - Uploads (client streams): the server grants byte credits by sending
 *   ClientStreamPull (driven by consumer _read demand); the client spends
 *   them with ClientStreamPush. A push exceeding the outstanding credit is a
 *   protocol violation and aborts the stream.
 * - Downloads (server streams): the client grants byte credits with
 *   ServerStreamPull; the credit pump emits at most that many bytes.
 *   A transport-dropped frame aborts the stream (credits keep outstanding
 *   data far below the transport backpressure limit, so this is a safety
 *   net, not a flow-control mechanism).
 * - Every stream has a single idle timeout, reset on any activity in either
 *   direction; expiry aborts the stream.
 */
export class BlobStreamsManager {
  readonly clientStreams = new Map<string, ClientStreamState>()
  readonly serverStreams = new Map<string, ServerStreamState>()

  // Index for quick lookup by callId (connectionId:callId -> Set<streamId>)
  readonly connectionClientStreams = new Map<string, Set<number>>()
  readonly connectionServerStreams = new Map<string, Set<number>>()
  readonly clientCallStreams = new Map<string, Set<number>>()
  readonly serverCallStreams = new Map<string, Set<number>>()

  readonly idleTimeout: number

  constructor(config: StreamConfig) {
    this.idleTimeout = config.idleTimeout
  }

  // --- Client Streams (Upload) ---

  createClientStream(
    connectionId: string,
    callId: number,
    streamId: number,
    metadata: ProtocolBlobMetadata,
    options: Stream.ReadableOptions,
  ) {
    const stream = new ProtocolClientStream(streamId, metadata, options)
    stream.on('error', noopFn)

    const key = this.getKey(connectionId, streamId)
    const state: ClientStreamState = {
      connectionId,
      callId,
      stream,
      granted: 0,
      idleTimer: undefined,
    }
    this.clientStreams.set(key, state)
    this.trackClientCall(connectionId, callId, streamId)
    this.trackConnectionClientStream(connectionId, streamId)

    this.touch(state)

    return stream
  }

  /** Records a pull about to be sent to the client as outstanding credit. */
  grantClientStream(connectionId: string, streamId: number, size: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      state.granted += size
      this.touch(state)
    }
  }

  /**
   * Returns `false` on a credit violation (push larger than the outstanding
   * grant) — the caller is expected to abort the stream and notify the peer.
   */
  pushToClientStream(
    connectionId: string,
    streamId: number,
    chunk: ArrayBufferView,
  ): boolean {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (!state) return true
    if (chunk.byteLength > state.granted) return false
    state.granted -= chunk.byteLength
    state.stream.write(chunk)
    this.touch(state)
    return true
  }

  endClientStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      state.stream.end(null)
      this.removeClientStream(connectionId, streamId)
    }
  }

  abortClientStream(connectionId: string, streamId: number, error = 'Aborted') {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      state.stream.destroy(new Error(error))
      this.removeClientStream(connectionId, streamId)
    }
  }

  consumeClientStream(connectionId: string, callId: number, streamId: number) {
    this.untrackClientCall(connectionId, callId, streamId)
  }

  getClientCallStreamIds(connectionId: string, callId: number) {
    const key = this.getCallKey(connectionId, callId)
    return [...(this.clientCallStreams.get(key) ?? [])]
  }

  getClientStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (!state) {
      throw new Error('Stream not found')
    }

    return state.stream
  }

  private removeClientStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      this.clientStreams.delete(key)
      this.clearIdleTimer(state)
      this.untrackClientCall(connectionId, state.callId, streamId)
      this.untrackConnectionClientStream(connectionId, streamId)
    }
  }

  // --- Server Streams (Download) ---

  getServerStreamsMetadata(connectionId: string, callId: number) {
    const key = this.getCallKey(connectionId, callId)
    const streamIds = this.serverCallStreams.get(key)
    const streams: EncodeRPCStreams = {}

    if (streamIds) {
      for (const streamId of streamIds) {
        const streamKey = this.getKey(connectionId, streamId)
        const state = this.serverStreams.get(streamKey)
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
    const key = this.getKey(connectionId, streamId)

    const stream = new ProtocolServerStream(streamId, blob, {
      chunk: (chunk) => {
        const state = this.serverStreams.get(key)
        if (state) this.touch(state)
        const sent = sink.chunk(chunk)
        if (sent === false) {
          this.abortServerStream(
            connectionId,
            streamId,
            STREAM_TRANSPORT_DROP_REASON,
          )
        }
        return sent
      },
      end: () => {
        this.removeServerStream(connectionId, streamId)
        sink.end()
      },
      error: (error) => {
        this.removeServerStream(connectionId, streamId)
        sink.error(error)
      },
    })

    const state: ServerStreamState = {
      connectionId,
      callId,
      stream,
      idleTimer: undefined,
    }

    this.serverStreams.set(key, state)
    this.trackServerCall(connectionId, callId, streamId)
    this.trackConnectionServerStream(connectionId, streamId)

    this.touch(state)

    return stream
  }

  pullServerStream(connectionId: string, streamId: number, size: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      this.touch(state)
      state.stream.grant(size)
    }
  }

  abortServerStream(connectionId: string, streamId: number, error = 'Aborted') {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      // destroy(error) reports through the stream sink, which removes the
      // state and notifies the peer
      state.stream.destroy(new Error(error))
      this.removeServerStream(connectionId, streamId)
    }
  }

  removeServerStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      this.serverStreams.delete(key)
      this.clearIdleTimer(state)
      this.untrackServerCall(connectionId, state.callId, streamId)
      this.untrackConnectionServerStream(connectionId, streamId)
    }
  }

  // --- Idle timeout ---

  private touch(state: StreamState) {
    this.clearIdleTimer(state)
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined
      if (state.stream instanceof ProtocolClientStream) {
        this.abortClientStream(
          state.connectionId,
          state.stream.id,
          STREAM_IDLE_TIMEOUT_REASON,
        )
      } else {
        this.abortServerStream(
          state.connectionId,
          state.stream.id,
          STREAM_IDLE_TIMEOUT_REASON,
        )
      }
    }, this.idleTimeout)
  }

  private clearIdleTimer(state: StreamState) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer)
      state.idleTimer = undefined
    }
  }

  // --- Helpers ---

  private getKey(connectionId: string, streamId: number) {
    return `${connectionId}:${streamId}`
  }

  private getCallKey(connectionId: string, callId: number) {
    return `${connectionId}:${callId}`
  }

  private trackClientCall(
    connectionId: string,
    callId: number,
    streamId: number,
  ) {
    const key = this.getCallKey(connectionId, callId)
    let set = this.clientCallStreams.get(key)
    if (!set) {
      set = new Set()
      this.clientCallStreams.set(key, set)
    }
    set.add(streamId)
  }

  private untrackClientCall(
    connectionId: string,
    callId: number,
    streamId: number,
  ) {
    const key = this.getCallKey(connectionId, callId)
    const set = this.clientCallStreams.get(key)
    if (set) {
      set.delete(streamId)
      if (set.size === 0) {
        this.clientCallStreams.delete(key)
      }
    }
  }

  private trackServerCall(
    connectionId: string,
    callId: number,
    streamId: number,
  ) {
    const key = this.getCallKey(connectionId, callId)
    let set = this.serverCallStreams.get(key)
    if (!set) {
      set = new Set()
      this.serverCallStreams.set(key, set)
    }
    set.add(streamId)
  }

  private untrackServerCall(
    connectionId: string,
    callId: number,
    streamId: number,
  ) {
    const key = this.getCallKey(connectionId, callId)
    const set = this.serverCallStreams.get(key)
    if (set) {
      set.delete(streamId)
      if (set.size === 0) {
        this.serverCallStreams.delete(key)
      }
    }
  }

  private trackConnectionClientStream(connectionId: string, streamId: number) {
    let set = this.connectionClientStreams.get(connectionId)
    if (!set) {
      set = new Set()
      this.connectionClientStreams.set(connectionId, set)
    }
    set.add(streamId)
  }

  private untrackConnectionClientStream(
    connectionId: string,
    streamId: number,
  ) {
    const set = this.connectionClientStreams.get(connectionId)
    if (set) {
      set.delete(streamId)
      if (set.size === 0) {
        this.connectionClientStreams.delete(connectionId)
      }
    }
  }

  private trackConnectionServerStream(connectionId: string, streamId: number) {
    let set = this.connectionServerStreams.get(connectionId)
    if (!set) {
      set = new Set()
      this.connectionServerStreams.set(connectionId, set)
    }
    set.add(streamId)
  }

  private untrackConnectionServerStream(
    connectionId: string,
    streamId: number,
  ) {
    const set = this.connectionServerStreams.get(connectionId)
    if (set) {
      set.delete(streamId)
      if (set.size === 0) {
        this.connectionServerStreams.delete(connectionId)
      }
    }
  }

  // --- Cleanup ---

  abortClientCallStreams(
    connectionId: string,
    callId: number,
    reason = 'Call aborted',
  ) {
    const key = this.getCallKey(connectionId, callId)
    const clientStreamIds = this.clientCallStreams.get(key)
    if (clientStreamIds) {
      for (const streamId of Array.from(clientStreamIds)) {
        this.abortClientStream(connectionId, streamId, reason)
      }
    }
  }

  cleanupConnection(connectionId: string) {
    const clientStreamIds = this.connectionClientStreams.get(connectionId)
    if (clientStreamIds) {
      for (const streamId of Array.from(clientStreamIds)) {
        this.abortClientStream(connectionId, streamId, 'Connection closed')
      }
    }

    const serverStreamIds = this.connectionServerStreams.get(connectionId)
    if (serverStreamIds) {
      for (const streamId of Array.from(serverStreamIds)) {
        this.abortServerStream(connectionId, streamId, 'Connection closed')
      }
    }
  }
}
