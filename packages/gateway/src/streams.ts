import type Stream from 'node:stream'

import type {
  EncodeRPCStreams,
  ProtocolBlob,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolRPCEncode } from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
import {
  ProtocolClientStream,
  ProtocolServerStream,
} from '@nmtjs/protocol/server'

import { StreamTimeout } from './enums.ts'

export type StreamConfig = {
  timeouts: {
    [StreamTimeout.Pull]: number
    [StreamTimeout.Consume]: number
    [StreamTimeout.Finish]: number
  }
}

type StreamTimeouts = Record<StreamTimeout, any>

type ClientStreamState = {
  connectionId: string
  callId: number
  stream: ProtocolClientStream
  timeouts: StreamTimeouts
}

type ServerStreamState = {
  connectionId: string
  callId: number
  stream: ProtocolServerStream
  timeouts: StreamTimeouts
}

type StreamState = ClientStreamState | ServerStreamState

/**
 * @todo Clarify Pull/Consume timeout semantics - currently ambiguous whether
 *       Pull timeout means "client not pulling" or "server not producing" for server streams
 */
export class BlobStreamsManager {
  readonly clientStreams = new Map<string, ClientStreamState>()
  readonly serverStreams = new Map<string, ServerStreamState>()

  // Index for quick lookup by callId (connectionId:callId -> Set<streamId>)
  readonly connectionClientStreams = new Map<string, Set<number>>()
  readonly connectionServerStreams = new Map<string, Set<number>>()
  readonly clientCallStreams = new Map<string, Set<number>>()
  readonly serverCallStreams = new Map<string, Set<number>>()

  readonly timeoutDurations: Record<StreamTimeout, number>

  constructor(config: StreamConfig) {
    this.timeoutDurations = {
      [StreamTimeout.Pull]: config.timeouts[StreamTimeout.Pull],
      [StreamTimeout.Consume]: config.timeouts[StreamTimeout.Consume],
      [StreamTimeout.Finish]: config.timeouts[StreamTimeout.Finish],
    }
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
      timeouts: {
        [StreamTimeout.Pull]: undefined,
        [StreamTimeout.Consume]: undefined,
        [StreamTimeout.Finish]: undefined,
      },
    }
    this.clientStreams.set(key, state)
    this.trackClientCall(connectionId, callId, streamId)
    this.trackConnectionClientStream(connectionId, streamId)

    this.startTimeout(state, StreamTimeout.Consume)

    return stream
  }

  pushToClientStream(
    connectionId: string,
    streamId: number,
    chunk: ArrayBufferView,
  ) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      state.stream.write(chunk)
      this.clearTimeout(state, StreamTimeout.Consume)
      this.startTimeout(state, StreamTimeout.Pull)
    }
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

  private removeClientStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.clientStreams.get(key)
    if (state) {
      this.clientStreams.delete(key)
      this.clearTimeout(state, StreamTimeout.Finish)
      this.clearTimeout(state, StreamTimeout.Pull)
      this.clearTimeout(state, StreamTimeout.Consume)
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
  ) {
    const stream = new ProtocolServerStream(streamId, blob)
    const key = this.getKey(connectionId, streamId)

    const state: ServerStreamState = {
      connectionId,
      callId,
      stream,
      timeouts: {
        [StreamTimeout.Pull]: undefined,
        [StreamTimeout.Consume]: undefined,
        [StreamTimeout.Finish]: undefined,
      },
    }

    // Prevent unhandled 'error' events, in case the user did not subscribe to them
    stream.on('error', noopFn)

    this.serverStreams.set(key, state)
    this.trackServerCall(connectionId, callId, streamId)
    this.trackConnectionServerStream(connectionId, streamId)

    this.startTimeout(state, StreamTimeout.Finish)
    this.startTimeout(state, StreamTimeout.Consume)

    return stream
  }

  pullServerStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      state.stream.resume()
      this.clearTimeout(state, StreamTimeout.Consume)
      this.startTimeout(state, StreamTimeout.Pull)
    }
  }

  abortServerStream(connectionId: string, streamId: number, error = 'Aborted') {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      state.stream.destroy(new Error(error))
      this.removeServerStream(connectionId, streamId)
    }
  }

  removeServerStream(connectionId: string, streamId: number) {
    const key = this.getKey(connectionId, streamId)
    const state = this.serverStreams.get(key)
    if (state) {
      this.serverStreams.delete(key)
      this.clearTimeout(state, StreamTimeout.Pull)
      this.clearTimeout(state, StreamTimeout.Consume)
      this.clearTimeout(state, StreamTimeout.Finish)
      this.untrackServerCall(connectionId, state.callId, streamId)
      this.untrackConnectionServerStream(connectionId, streamId)
    }
  }

  // --- Timeouts ---

  private startTimeout(state: StreamState, type: StreamTimeout) {
    this.clearTimeout(state, type)
    const duration = this.timeoutDurations[type]
    const timeout = setTimeout(() => {
      if (state.stream instanceof ProtocolClientStream) {
        this.abortClientStream(
          state.connectionId,
          state.stream.id,
          `${type} timeout`,
        )
      } else {
        this.abortServerStream(
          state.connectionId,
          state.stream.id,
          `${type} timeout`,
        )
      }
      state.timeouts[type] = undefined
    }, duration)
    state.timeouts[type] = timeout
  }

  private clearTimeout(state: StreamState, type: StreamTimeout) {
    const timeout = state.timeouts[type]
    if (timeout) {
      clearTimeout(timeout)
      state.timeouts[type] = undefined
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
      for (const streamId of [...clientStreamIds]) {
        this.abortClientStream(connectionId, streamId, reason)
      }
    }
  }

  cleanupConnection(connectionId: string) {
    const clientStreamIds = this.connectionClientStreams.get(connectionId)
    if (clientStreamIds) {
      for (const streamId of [...clientStreamIds]) {
        this.abortClientStream(connectionId, streamId, 'Connection closed')
      }
    }

    const serverStreamIds = this.connectionServerStreams.get(connectionId)
    if (serverStreamIds) {
      for (const streamId of [...serverStreamIds]) {
        this.abortServerStream(connectionId, streamId, 'Connection closed')
      }
    }
  }
}
