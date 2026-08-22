import { Buffer } from 'node:buffer'

import type { ResolveInjectableType } from '@nmtjs/core'
import type {
  GatewayConnection,
  GatewayInjectables,
  GatewayResolvedProcedure,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type { ProtocolBlobInterface, ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseServerDecoder,
  BaseServerEncoder,
  MessageContext,
  ProtocolVersionInterface,
  SendResult,
} from '@nmtjs/protocol/server'
import {
  createFuture,
  isAbortError,
  isAsyncIterable,
  MAX_UINT32,
  noopFn,
  withTimeout,
} from '@nmtjs/common'
import { provision } from '@nmtjs/core'
import { consumeBlob, createBlob } from '@nmtjs/gateway'
import {
  ClientMessageType,
  createProtocolBlobReference,
  getProtocolBlobStreamId,
  ProtocolBlob,
  ServerMessageType,
} from '@nmtjs/protocol'
import {
  MAX_STREAM_CREDITS,
  ProtocolError,
  versions,
} from '@nmtjs/protocol/server'

import { RpcManager } from './rpcs.ts'
import {
  BlobStreamsManager,
  STREAM_CREDIT_VIOLATION_REASON,
  STREAM_IDLE_TIMEOUT_REASON,
  STREAM_TRANSPORT_DROP_REASON,
} from './streams.ts'

type RpcStreamCreditState = {
  credits: number
  // credits granted since the previous idle wait
  idleCredits: number
  // resolves the in-flight credit wait; also poked on abort/teardown
  notify: (() => void) | null
  // fails the whole stream (e.g. credit violation) from the message handler
  fail: (error: Error) => void
}

/**
 * Flow-control failure whose message is meant for the peer (sent as the
 * stream abort reason) rather than logged as a server error.
 */
class StreamFlowError extends Error {}

export const DEFAULT_WS_HEARTBEAT_INTERVAL = 15000
export const DEFAULT_WS_HEARTBEAT_TIMEOUT = 5000
export const DEFAULT_STREAM_IDLE_TIMEOUT = 30_000
// Node clamps larger timer delays to 1ms, which would invert a large credit
// window into an immediate timeout.
const MAX_TIMER_DELAY = 2 ** 31 - 1
/**
 * Upper bound for the RPC stream iterator's return() during cleanup: on
 * async generators it queues behind a stalled next(), so unwinding is only
 * cooperative and must not hang the message handler forever.
 */
export const RPC_STREAM_CLEANUP_TIMEOUT = 10_000
/**
 * Once a terminal stream frame (end/abort) is dropped by the transport,
 * stream-level recovery is impossible — the peer would wait forever. Closing
 * the connection guarantees peer-side cleanup via the socket close.
 */
const TERMINAL_FRAME_DROP_CLOSE = {
  code: 1011,
  reason: 'stream terminal frame dropped',
}

export type WsSessionHeartbeatOptions =
  | false
  | { interval?: number; timeout?: number }

export interface WsSessionEngineOptions {
  /**
   * Bounds peer inactivity per stream. For RPC streams it caps only how long
   * the server waits for consumer credit (a client that isn't pulling). The
   * allowance applies per exhausted chunk credit, so a batched grant does not
   * reduce the time available to consume each chunk. Producer stalls with a
   * live, waiting consumer are allowed indefinitely (sparse streams, e.g.
   * pubsub subscriptions). Consequently, a larger RPC window also allows an
   * inactive consumer to retain the stream longer. For blob streams it bounds
   * inactivity in either direction (chunk sent/received, credit
   * granted/received). Expiry aborts the stream.
   */
  streamIdleTimeout?: number
  /**
   * Server-initiated heartbeat: the session periodically sends protocol
   * Ping and expects Pong; a missed Pong terminates the connection.
   */
  heartbeat?: WsSessionHeartbeatOptions
  send: (connectionId: string, buffer: ArrayBufferView) => SendResult
  /**
   * Initiates a full session disconnect (socket close + gateway
   * disconnect). Used when only a connection close can recover: dropped
   * terminal frames, heartbeat timeout.
   */
  terminate: (
    connectionId: string,
    close: { code: number; reason: string },
  ) => Promise<void>
  logger?: Pick<Console, 'warn' | 'error'>
}

type WsSessionCodecs = {
  protocolVersion: ProtocolVersion
  encoder: BaseServerEncoder
  decoder: BaseServerDecoder
}

type WsSession = {
  connection: GatewayConnection
  protocol: ProtocolVersionInterface
  encoder: BaseServerEncoder
  decoder: BaseServerDecoder
  nextStreamId: number
  heartbeat?: {
    abortController: AbortController
    pending: Map<number, ReturnType<typeof createFuture<void>>>
    nonce: number
  }
}

/**
 * The native WebSocket session engine: everything between raw frames and
 * gateway calls. Owns protocol codec use, wire call ids, RPC stream chunk
 * credits, blob streams with byte credits, heartbeats, and terminal-frame
 * failure policy — the wire-level machinery the gateway (an application
 * kernel) must not know about. One engine serves every session of a mounted
 * handler; state is keyed by connection id.
 */
export class WsSessionEngine {
  readonly rpcs = new RpcManager()
  readonly blobStreams: BlobStreamsManager
  readonly sessions = new Map<string, WsSession>()
  /**
   * Chunk-count credits for in-flight RPC streaming responses, keyed by
   * connectionId:callId. Entries live strictly within the streaming section
   * of handleRpc (the callId is reserved in RpcManager for that whole span,
   * so there is no reuse race); teardown also sweeps by connection.
   */
  private readonly rpcStreamCredits = new Map<string, RpcStreamCreditState>()
  readonly streamIdleTimeout: number
  private readonly logger: Pick<Console, 'warn' | 'error'>

  constructor(
    readonly params: Pick<
      TransportWorkerParams<GatewayResolvedProcedure>,
      'onRpc'
    >,
    readonly options: WsSessionEngineOptions,
  ) {
    this.streamIdleTimeout =
      options.streamIdleTimeout ?? DEFAULT_STREAM_IDLE_TIMEOUT
    this.blobStreams = new BlobStreamsManager({
      idleTimeout: this.streamIdleTimeout,
    })
    this.logger = options.logger ?? console
  }

  /** Registers a session for an established gateway connection. */
  open(connection: GatewayConnection, codecs: WsSessionCodecs): void {
    const protocol = versions[codecs.protocolVersion]
    if (!protocol) throw new Error('Unsupported protocol version')

    const session: WsSession = {
      connection,
      protocol,
      encoder: codecs.encoder,
      decoder: codecs.decoder,
      nextStreamId: 0,
    }
    this.sessions.set(connection.id, session)
    this.startHeartbeat(session)
  }

  /**
   * Sweeps every piece of wire state for a session. Runs before the gateway
   * disconnect so in-flight calls observe their wire aborts first.
   */
  close(connectionId: string): void {
    const session = this.sessions.get(connectionId)
    if (!session) return
    this.sessions.delete(connectionId)
    this.stopHeartbeat(session, 'close')
    this.rpcs.close(connectionId)
    this.releaseRpcStreamCredits(connectionId)
    this.blobStreams.cleanupConnection(connectionId)
  }

  async receive(
    connectionId: string,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    const session = this.sessions.get(connectionId)
    if (!session) throw new Error('Session not found')
    const context = this.createMessageContext(session)

    const frame = ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data)
    const message = session.protocol.decodeMessage(context, frame)

    switch (message.type) {
      case ClientMessageType.Ping: {
        this.send(
          session,
          session.protocol.encodeMessage(context, ServerMessageType.Pong, {
            nonce: message.nonce,
          }),
        )
        break
      }
      case ClientMessageType.Pong: {
        const pending = session.heartbeat?.pending.get(message.nonce)
        if (pending) {
          session.heartbeat!.pending.delete(message.nonce)
          pending.resolve()
        }
        break
      }
      case ClientMessageType.Rpc: {
        // reusing an active callId would hijack the in-flight call's
        // abort controller and interleave responses — drop the message
        // silently, an error response would reject the pending call
        // on the client side
        if (this.rpcs.get(connectionId, message.rpc.callId)) {
          this.logger.warn(
            `Duplicate RPC call id ${message.rpc.callId} on connection ${connectionId}, dropping message`,
          )
          break
        }
        const { callId, procedure, payload } = message.rpc
        const controller = new AbortController()
        this.rpcs.set(connectionId, callId, controller)
        try {
          await this.handleRpc(
            session,
            context,
            { callId, procedure, payload },
            controller.signal,
          )
        } finally {
          // Abort uploads tied to this call that the handler never consumed;
          // the per-stream notifier delivers the wire abort at most once
          this.blobStreams.abortClientCallStreams(
            connectionId,
            callId,
            'Blob was not consumed before handler completed',
          )
          this.rpcs.delete(connectionId, callId, controller)
        }
        break
      }
      case ClientMessageType.RpcAbort: {
        this.rpcs.abort(connectionId, message.callId)
        break
      }
      case ClientMessageType.ClientBlobAbort: {
        // peer-originated: never echo the abort back
        this.blobStreams.abortClientStream(
          connectionId,
          message.streamId,
          message.reason,
          false,
        )
        break
      }
      case ClientMessageType.ClientBlobPush: {
        const accepted = this.blobStreams.pushToClientStream(
          connectionId,
          message.streamId,
          message.chunk,
        )
        if (!accepted) {
          this.logger.warn(
            `Client stream ${message.streamId} push exceeds granted credit, aborting stream`,
          )
          this.blobStreams.abortClientStream(
            connectionId,
            message.streamId,
            STREAM_CREDIT_VIOLATION_REASON,
          )
        }
        break
      }
      case ClientMessageType.ClientBlobEnd: {
        this.blobStreams.endClientStream(connectionId, message.streamId)
        break
      }
      case ClientMessageType.ServerBlobAbort: {
        // peer-originated: never echo the abort back
        this.blobStreams.abortServerStream(
          connectionId,
          message.streamId,
          message.reason,
          false,
        )
        break
      }
      case ClientMessageType.ServerBlobPull: {
        if (message.size === 0) {
          // zero-size pulls grant nothing but would reset the idle timer
          // forever — a free keepalive, so treat them as violations
          this.logger.warn(
            `Zero-size server stream ${message.streamId} pull, aborting stream`,
          )
          this.blobStreams.abortServerStream(
            connectionId,
            message.streamId,
            STREAM_CREDIT_VIOLATION_REASON,
          )
          break
        }
        this.blobStreams.pullServerStream(
          connectionId,
          message.streamId,
          message.size,
        )
        break
      }
      case ClientMessageType.RpcStreamPull: {
        const credit = this.rpcStreamCredits.get(
          `${connectionId}:${message.callId}`,
        )
        if (credit) {
          // zero-size pulls are a free keepalive, oversized totals break
          // the counter — both are violations
          if (
            message.size === 0 ||
            credit.credits + message.size > MAX_STREAM_CREDITS
          ) {
            this.logger.warn(
              `Invalid RPC stream pull size ${message.size} for call ${message.callId}, aborting stream`,
            )
            credit.fail(new StreamFlowError(STREAM_CREDIT_VIOLATION_REASON))
            break
          }
          credit.credits += message.size
          credit.idleCredits = Math.min(
            credit.idleCredits + message.size,
            MAX_STREAM_CREDITS,
          )
          credit.notify?.()
        }
        break
      }
      default:
        throw new Error('Unknown message type')
    }
  }

  private async handleRpc(
    session: WsSession,
    context: MessageContext,
    rpc: { callId: number; procedure: string; payload: unknown },
    signal: AbortSignal,
  ): Promise<void> {
    const { connection, protocol, encoder } = session
    const connectionId = connection.id
    const { callId } = rpc

    try {
      const response = await this.params.onRpc(
        connection,
        { procedure: rpc.procedure, payload: rpc.payload },
        signal,
        provision(
          createBlob,
          this.createBlobFunction(session, context, callId),
        ),
        provision(consumeBlob, this.consumeBlobFunction(connectionId, callId)),
      )

      if (isAsyncIterable(response)) {
        // don't open a stream for a call aborted while dispatching
        signal.throwIfAborted()

        const creditKey = `${connectionId}:${callId}`
        // Rejects on call abort or a credit violation. Every await in the
        // streaming loop races against it, so a handler stalled inside
        // next() cannot outlive the call (client abort, connection teardown).
        // Deliberately NOT wired to the idle timer: a silent producer with a
        // live, waiting client is not a fault (sparse streams, e.g. pubsub
        // subscriptions) — the client controls cancellation and heartbeat
        // reaps dead connections into the same abort signal.
        const flow = createFuture<never>()
        flow.promise.catch(noopFn)
        const credit: RpcStreamCreditState = {
          credits: 0,
          idleCredits: 0,
          notify: null,
          fail: (error) => flow.reject(error),
        }
        // installed BEFORE RpcStreamResponse goes out: a synchronous
        // transport may deliver the first pull re-entrantly during the send
        this.rpcStreamCredits.set(creditKey, credit)
        const onAbort = () => flow.reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })

        let iterator: AsyncIterator<unknown> | undefined
        try {
          const sentResponse = this.send(
            session,
            protocol.encodeMessage(
              context,
              ServerMessageType.RpcStreamResponse,
              { callId },
            ),
          )
          if (sentResponse === 'dropped') {
            // the client never learns this call is a stream; nothing
            // stream-level can recover it
            void this.options.terminate(connectionId, TERMINAL_FRAME_DROP_CLOSE)
            return
          }
          signal.throwIfAborted()

          iterator = (response as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]()

          while (true) {
            // The credit wait comes BEFORE next(): a consumer that never
            // iterates must not pin the generator, call container and
            // reservation forever — with zero credit the producer is never
            // advanced and the wait's idle timer reaps the stream. Sparse
            // producers stay safe: a waiting consumer has already granted
            // credit before the silence, and next() races only the abort.
            while (credit.credits <= 0) {
              // idle detection bounds only consumer inactivity: the producer
              // is ready but the client isn't pulling
              const idleTimeout = Math.min(
                this.streamIdleTimeout * Math.max(credit.idleCredits, 1),
                MAX_TIMER_DELAY,
              )
              credit.idleCredits = 0
              const grant = createFuture<void>()
              credit.notify = grant.resolve
              const idleTimer = setTimeout(
                () =>
                  flow.reject(new StreamFlowError(STREAM_IDLE_TIMEOUT_REASON)),
                idleTimeout,
              )
              try {
                await Promise.race([grant.promise, flow.promise])
              } finally {
                clearTimeout(idleTimer)
                credit.notify = null
              }
              signal.throwIfAborted()
            }
            const result = (await Promise.race([
              iterator.next(),
              flow.promise,
            ])) as IteratorResult<unknown>
            // the last credit is answered by End instead of a chunk: the
            // consumer's final read resolves done
            if (result.done) break
            signal.throwIfAborted()
            credit.credits--
            const chunkEncoded = encoder.encode(result.value)
            const sent = this.send(
              session,
              protocol.encodeMessage(
                context,
                ServerMessageType.RpcStreamChunk,
                {
                  callId,
                  chunk: chunkEncoded,
                },
              ),
            )
            if (sent === 'dropped') {
              throw new StreamFlowError(STREAM_TRANSPORT_DROP_REASON)
            }
          }

          const sentEnd = this.send(
            session,
            protocol.encodeMessage(context, ServerMessageType.RpcStreamEnd, {
              callId,
            }),
          )
          if (sentEnd === 'dropped') {
            // terminal frame lost: the client would wait forever
            void this.options.terminate(connectionId, TERMINAL_FRAME_DROP_CLOSE)
          }
        } catch (error) {
          if (!isAbortError(error) && !(error instanceof StreamFlowError)) {
            this.logger.error(error)
          }
          const sentAbort = this.send(
            session,
            protocol.encodeMessage(context, ServerMessageType.RpcStreamAbort, {
              callId,
              reason:
                error instanceof StreamFlowError ? error.message : undefined,
            }),
          )
          if (sentAbort === 'dropped') {
            void this.options.terminate(connectionId, TERMINAL_FRAME_DROP_CLOSE)
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          this.rpcStreamCredits.delete(creditKey)
          if (iterator) {
            // cooperative unwind on every exit path; timeboxed because
            // return() queues behind a stalled next() on async generators
            try {
              await withTimeout(
                Promise.resolve(iterator.return?.()),
                RPC_STREAM_CLEANUP_TIMEOUT,
                new Error('RPC stream iterator cleanup timed out'),
              )
            } catch (error) {
              this.logger.warn(
                `RPC stream iterator cleanup failed for call ${callId}`,
                error,
              )
            }
          }
        }
      } else {
        const streams = this.blobStreams.getServerStreamsMetadata(
          connectionId,
          callId,
        )
        this.send(
          session,
          protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
            callId,
            result: response,
            streams,
            error: null,
          }),
        )
      }
    } catch (error) {
      this.send(
        session,
        protocol.encodeMessage(context, ServerMessageType.RpcResponse, {
          callId,
          result: null,
          streams: {},
          error,
        }),
      )
      if (!(error instanceof ProtocolError)) this.logger.error(error)
    }
  }

  private send(session: WsSession, buffer: ArrayBufferView): SendResult {
    return this.options.send(session.connection.id, buffer)
  }

  private createMessageContext(session: WsSession): MessageContext {
    const { protocol, decoder, encoder } = session
    const connectionId = session.connection.id

    const context: MessageContext = {
      connectionId,
      protocol,
      encoder,
      decoder,
      transport: { send: this.options.send },
      streamId: () => {
        let streamId = session.nextStreamId
        if (streamId >= MAX_UINT32) streamId = 0
        session.nextStreamId = streamId + 1
        return streamId
      },
      addClientStream: ({ streamId, callId, metadata }) => {
        this.blobStreams.createClientStream(
          connectionId,
          callId,
          streamId,
          metadata,
          {
            read: (size) => {
              // record the grant before it goes on the wire so a push racing
              // in can never be flagged as a credit violation
              const pullSize = size || 65535
              this.blobStreams.grantClientStream(
                connectionId,
                streamId,
                pullSize,
              )
              const sent = this.send(
                session,
                protocol.encodeMessage(
                  context,
                  ServerMessageType.ClientBlobPull,
                  { streamId, size: pullSize },
                ),
              )
              if (sent === 'dropped') {
                // phantom credit would stall both sides: Node won't re-invoke
                // _read for a pull the client never received
                this.blobStreams.revokeClientStreamGrant(
                  connectionId,
                  streamId,
                  pullSize,
                )
                this.blobStreams.abortClientStream(
                  connectionId,
                  streamId,
                  STREAM_TRANSPORT_DROP_REASON,
                )
              }
            },
          },
          (reason) => {
            const sent = this.send(
              session,
              protocol.encodeMessage(
                context,
                ServerMessageType.ClientBlobAbort,
                { streamId, reason },
              ),
            )
            if (sent === 'dropped') {
              void this.options.terminate(
                connectionId,
                TERMINAL_FRAME_DROP_CLOSE,
              )
            }
          },
        )

        return createProtocolBlobReference(streamId, metadata)
      },
    }

    return context
  }

  private createBlobFunction(
    session: WsSession,
    context: MessageContext,
    callId: number,
  ): ResolveInjectableType<typeof GatewayInjectables.createBlob> {
    const { protocol, encoder } = session
    const connectionId = session.connection.id

    return (source, metadata) => {
      const streamId = context.streamId()
      const blob = ProtocolBlob.from(source, metadata, (metadata) => {
        return encoder.encodeBlob(streamId, metadata)
      })
      // the credit pump drives this sink; the manager aborts the stream when
      // chunk delivery reports a dropped frame
      this.blobStreams.createServerStream(
        connectionId,
        callId,
        streamId,
        blob,
        {
          chunk: (chunk) => {
            return this.send(
              session,
              protocol.encodeMessage(
                context,
                ServerMessageType.ServerBlobPush,
                {
                  streamId,
                  chunk,
                },
              ),
            )
          },
          end: () => {
            const sent = this.send(
              session,
              protocol.encodeMessage(context, ServerMessageType.ServerBlobEnd, {
                streamId,
              }),
            )
            if (sent === 'dropped') {
              // terminal frame lost after local state removal: the client
              // would wait forever, only a connection close can recover
              void this.options.terminate(
                connectionId,
                TERMINAL_FRAME_DROP_CLOSE,
              )
            }
          },
          error: (error) => {
            const sent = this.send(
              session,
              protocol.encodeMessage(
                context,
                ServerMessageType.ServerBlobAbort,
                { streamId, reason: error.message },
              ),
            )
            if (sent === 'dropped') {
              void this.options.terminate(
                connectionId,
                TERMINAL_FRAME_DROP_CLOSE,
              )
            }
          },
        },
      )

      return blob
    }
  }

  private consumeBlobFunction(
    connectionId: string,
    callId: number,
  ): ResolveInjectableType<typeof GatewayInjectables.consumeBlob> {
    return (blob: ProtocolBlobInterface) => {
      const streamId = getProtocolBlobStreamId(blob)
      this.blobStreams.consumeClientStream(connectionId, callId, streamId)
      return this.blobStreams.getClientStream(connectionId, streamId)
    }
  }

  private resolveHeartbeatConfig() {
    const heartbeat = this.options.heartbeat
    if (heartbeat === false) return null
    return {
      interval: heartbeat?.interval ?? DEFAULT_WS_HEARTBEAT_INTERVAL,
      timeout: heartbeat?.timeout ?? DEFAULT_WS_HEARTBEAT_TIMEOUT,
    }
  }

  private startHeartbeat(session: WsSession) {
    const config = this.resolveHeartbeatConfig()
    if (!config) return

    const connectionId = session.connection.id
    const abortController = new AbortController()
    const signal = abortController.signal

    const state = {
      abortController,
      pending: new Map<number, ReturnType<typeof createFuture<void>>>(),
      nonce: 0,
    }
    session.heartbeat = state

    const loop = async () => {
      while (!signal.aborted && this.sessions.get(connectionId) === session) {
        await new Promise((resolve) => setTimeout(resolve, config.interval))
        if (signal.aborted || this.sessions.get(connectionId) !== session) break

        const context = this.createMessageContext(session)
        const nonce = state.nonce++

        const future = createFuture<void>()
        state.pending.set(nonce, future)

        try {
          this.send(
            session,
            session.protocol.encodeMessage(context, ServerMessageType.Ping, {
              nonce,
            }),
          )

          await withTimeout(
            future.promise,
            config.timeout,
            new Error('Heartbeat timeout'),
          )
        } catch {
          state.pending.delete(nonce)
          // terminate() funnels into the single claimed teardown so the
          // socket is closed exactly once even when a disconnect races in
          await this.options.terminate(connectionId, {
            code: 1001,
            reason: 'heartbeat_timeout',
          })
          break
        }
      }
    }

    loop().catch(noopFn)
  }

  private stopHeartbeat(session: WsSession, reason?: any) {
    const state = session.heartbeat
    if (!state) return
    session.heartbeat = undefined
    state.abortController.abort(reason)

    if (state.pending.size) {
      const error = new Error('Heartbeat stopped', { cause: reason })
      for (const pending of state.pending.values()) pending.reject(error)
      state.pending.clear()
    }
  }

  private releaseRpcStreamCredits(connectionId: string) {
    const prefix = `${connectionId}:`
    for (const [key, credit] of this.rpcStreamCredits) {
      if (key.startsWith(prefix)) {
        this.rpcStreamCredits.delete(key)
        credit.notify?.()
      }
    }
  }
}
