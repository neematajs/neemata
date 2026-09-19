import type { Future } from '@nmtjs/common'
import type { BaseProtocolError } from '@nmtjs/protocol'
import type { ServerMessageTypePayload } from '@nmtjs/protocol/client'
import {
  anyAbortSignal,
  createFuture,
  MAX_UINT32,
  noopFn,
  onAbort,
} from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  isBlobInterface,
  ProtocolBlob,
  ReceiveCreditWindow,
  ServerMessageType,
  STREAM_FLOW_CONTROL_VIOLATION_REASON,
} from '@nmtjs/protocol'
import { ProtocolError, ProtocolServerRPCStream } from '@nmtjs/protocol/client'

import type { ClientCore } from '../core.ts'
import type { BaseClientTransformer } from '../transformers.ts'
import type {
  TransportCallResponse,
  TransportErrorResponse,
} from '../transport.ts'
import type { StreamCallOptions } from '../types.ts'
import type { StreamLayerApi } from './streams.ts'
import { ServerStreams } from '../stream-registry.ts'
import { createIdCounter, toReasonString } from '../utils.ts'

type Call = Future<any> & {
  procedure: string
  signal: AbortSignal
  streamWindow: number
  cleanup?: () => void
}

export interface RpcLayerApi {
  call(
    procedure: string,
    payload: any,
    options?: StreamCallOptions,
    params?: { stream?: boolean },
  ): Promise<any>
}

const DEFAULT_STREAM_WINDOW = 16

const validateStreamWindow = (value: number) => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_UINT32) {
    throw new RangeError(
      'backpressure.rpc.window must be a positive uint32 integer',
    )
  }
  return value
}

const toAbortError = (signal: AbortSignal) => {
  return new ProtocolError(ErrorCode.ClientRequestError, String(signal.reason))
}

const connectIfNeeded = async (core: ClientCore, signal: AbortSignal) => {
  if (core.state !== 'connected' && core.shouldConnectOnCall()) {
    if (signal.aborted) throw toAbortError(signal)

    const connecting = core.connect()

    await new Promise<void>((resolve, reject) => {
      const off = onAbort(signal, () => reject(toAbortError(signal)))
      connecting.then(resolve, reject).finally(off)
    })
  }

  if (core.state !== 'connected') {
    throw new ProtocolError(
      ErrorCode.ConnectionError,
      'Client is not connected',
    )
  }
}

const waitUntilConnected = (core: ClientCore, signal?: AbortSignal) => {
  if (core.state === 'connected') return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    let removeAbort = noopFn

    const offConnected = core.once('connected', () => {
      removeAbort()
      resolve()
    })

    if (signal) {
      removeAbort = onAbort(signal, () => {
        offConnected()
        reject(signal.reason)
      })
    }
  })
}

async function* reconnectingAsyncIterable<T>(
  core: ClientCore,
  initialIterable: AsyncIterable<T>,
  callFn: () => Promise<AsyncIterable<T>>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let iterable: AsyncIterable<T> | null = initialIterable

  while (!signal?.aborted) {
    try {
      const currentIterable = iterable ?? (await callFn())
      iterable = null

      for await (const item of currentIterable) {
        yield item
      }
      return
    } catch (error) {
      iterable = null

      if (signal?.aborted) throw error

      if (
        error instanceof ProtocolError &&
        error.code === ErrorCode.ConnectionError
      ) {
        await waitUntilConnected(core, signal)
        continue
      }

      throw error
    }
  }
}

const createManagedAsyncIterable = <T>(
  iterable: AsyncIterable<T>,
  options: {
    onDone?: () => void
    onReturn?: (value: unknown) => void
    onThrow?: (error: unknown) => void
  },
): AsyncIterable<T> => {
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        options.onDone?.()
      }

      return {
        async next() {
          const result = await iterator.next()
          if (result.done) {
            finish()
          }
          return result
        },
        async return(value) {
          options.onReturn?.(value)
          finish()
          return iterator.return?.(value) ?? { done: true, value }
        },
        async throw(error) {
          options.onThrow?.(error)
          finish()
          return iterator.throw?.(error) ?? Promise.reject(error)
        },
      }
    },
  }
}

export const createRpcLayer = (
  core: ClientCore,
  streams: StreamLayerApi,
  transformer: BaseClientTransformer,
  options: {
    timeout?: number
    rpcStreamWindow?: number
    safe?: boolean
  } = {},
): RpcLayerApi => {
  const calls = new Map<number, Call>()
  const rpcStreams = new ServerStreams<ProtocolServerRPCStream>()
  const streamCredits = new Map<number, ReceiveCreditWindow>()
  const defaultWindow = validateStreamWindow(
    options.rpcStreamWindow ?? DEFAULT_STREAM_WINDOW,
  )
  const nextCallId = createIdCounter()

  const sendAbort = (callId: number, reason?: string) => {
    core
      .sendMessage(ClientMessageType.RpcAbort, { callId, reason })
      ?.catch(noopFn)
  }

  // credits, the abort listener and the pending entry always go together
  const release = (callId: number) => {
    streamCredits.delete(callId)
    const call = calls.get(callId)
    call?.cleanup?.()
    calls.delete(callId)
    return call
  }

  const emitError = (callId: number, procedure: string, error: unknown) => {
    core.emitClientEvent({ kind: 'rpc_error', callId, procedure, error })
  }

  const emitStreamResponse = (callId: number, call: Call) => {
    core.emitClientEvent({
      kind: 'rpc_response',
      callId,
      procedure: call.procedure,
      stream: true,
    })
  }

  const rejectServerError = (
    callId: number,
    call: Call,
    error: BaseProtocolError,
  ) => {
    emitError(callId, call.procedure, error)
    call.reject(new ProtocolError(error.code, error.message, error.data))
  }

  const rejectUndecodable = (callId: number, call: Call, error: unknown) => {
    emitError(callId, call.procedure, error)
    call.reject(
      new ProtocolError(
        ErrorCode.ClientRequestError,
        'Unable to decode response',
        error,
      ),
    )
  }

  const resolveResult = (callId: number, call: Call, result: unknown) => {
    try {
      const body = transformer.decode(call.procedure, result)
      core.emitClientEvent({
        kind: 'rpc_response',
        callId,
        procedure: call.procedure,
        body,
      })
      call.resolve(body)
    } catch (error) {
      rejectUndecodable(callId, call, error)
    }
  }

  // A failed local push (e.g. transform/decode error) must surface as a
  // stream abort on both sides, never as an unhandled rejection.
  const abortStreamOnPushFailure = (callId: number, reason: unknown) => {
    if (!rpcStreams.has(callId)) return

    release(callId)
    void rpcStreams.abort(callId, reason).catch(noopFn)

    if (core.messageContext) {
      const reasonString = toReasonString(reason)

      core.emitStreamEvent({
        direction: 'outgoing',
        streamType: 'rpc',
        action: 'abort',
        callId,
        reason: reasonString,
      })

      sendAbort(callId, reasonString)
    }
  }

  const createRpcStream = (callId: number, call: Call) => {
    const { procedure, signal, streamWindow } = call
    const credits = new ReceiveCreditWindow({
      capacity: streamWindow,
      refill: Math.ceil(streamWindow / 2),
    })

    const stream = new ProtocolServerRPCStream({
      pull: (_controller, consumed) => {
        if (!core.messageContext) return

        const size = credits.onDemand(consumed === undefined ? 0 : 1)
        if (size === 0) return

        // Batch refills preserve a bounded producer lead without putting a
        // wire round trip on every consumer read.
        core.emitStreamEvent({
          direction: 'outgoing',
          streamType: 'rpc',
          action: 'pull',
          callId,
        })

        core
          .sendMessage(ClientMessageType.RpcStreamPull, { callId, size })
          ?.catch((error) => {
            credits.revoke(size)
            abortStreamOnPushFailure(callId, error)
          })
      },
      start: (controller) => {
        if (signal.aborted) {
          controller.error(signal.reason)
          return
        }

        call.cleanup = onAbort(signal, () => {
          streamCredits.delete(callId)
          controller.error(signal.reason)

          if (rpcStreams.has(callId)) {
            void rpcStreams.abort(callId).catch(noopFn)
            sendAbort(callId, toReasonString(signal.reason))
          }
        })
      },
      transform: (chunk) => {
        return transformer.decode(procedure, core.codec.decode(chunk))
      },
      readableStrategy: { highWaterMark: 0 },
    })

    rpcStreams.add(callId, stream)
    streamCredits.set(callId, credits)
    call.resolve(stream)
  }

  // Unidirectional transports deliver their own readable; republish it as an
  // RPC stream so both transports hand the caller the same thing.
  const adoptRpcStream = (
    callId: number,
    call: Call,
    source: ReadableStream<ArrayBufferView>,
  ) => {
    const reader = source.getReader()
    const { signal } = call
    let removeAbort = noopFn

    const stream = new ProtocolServerRPCStream({
      start: (controller) => {
        const abort = () => {
          controller.error(signal.reason)
          reader.cancel(signal.reason).catch(noopFn)
          void rpcStreams.abort(callId).catch(noopFn)
        }

        if (signal.aborted) {
          abort()
        } else {
          removeAbort = onAbort(signal, abort)
        }
      },
      transform: (chunk) => {
        return transformer.decode(call.procedure, core.codec.decode(chunk))
      },
      readableStrategy: { highWaterMark: 0 },
    })

    rpcStreams.add(callId, stream)
    call.resolve(stream)

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await rpcStreams.push(callId, value)
        }
        await rpcStreams.end(callId)
      } catch {
        await rpcStreams.abort(callId).catch(noopFn)
      } finally {
        reader.releaseLock()
        removeAbort()
      }
    })()
  }

  const toTransportError = (response: TransportErrorResponse) => {
    try {
      const decoded = core.codec.decode(response.error) as {
        code?: string
        message?: string
        data?: unknown
      }

      return new ProtocolError(
        decoded.code || ErrorCode.ClientRequestError,
        decoded.message || response.statusText || 'Request failed',
        decoded.data,
      )
    } catch {
      return new ProtocolError(
        ErrorCode.ClientRequestError,
        response.statusText
          ? `HTTP ${response.status ?? ''}: ${response.statusText}`.trim()
          : 'Request failed',
      )
    }
  }

  const handleCallResponse = (
    callId: number,
    response: TransportCallResponse,
  ) => {
    const call = calls.get(callId)

    switch (response.type) {
      case 'error': {
        if (!call) break

        const error = toTransportError(response)
        emitError(callId, call.procedure, error)
        call.reject(error)
        break
      }
      case 'rpc_stream': {
        if (!call) {
          response.stream.cancel().catch(noopFn)
          break
        }

        emitStreamResponse(callId, call)
        adoptRpcStream(callId, call, response.stream)
        break
      }
      case 'blob': {
        if (!call) {
          response.source.cancel().catch(noopFn)
          break
        }

        emitStreamResponse(callId, call)
        call.resolve(
          streams.addServerBlobStream(response.metadata, response.source),
        )
        break
      }
      case 'rpc': {
        if (!call) break

        let result: unknown
        try {
          result =
            response.result.byteLength === 0
              ? undefined
              : core.codec.decode(response.result)
        } catch (error) {
          rejectUndecodable(callId, call, error)
          break
        }

        resolveResult(callId, call, result)
        break
      }
    }
  }

  const handleResponse = (
    message: ServerMessageTypePayload[ServerMessageType.RpcResponse],
  ) => {
    const call = calls.get(message.callId)
    if (!call) return

    if (message.error) {
      rejectServerError(message.callId, call, message.error)
      return
    }

    resolveResult(message.callId, call, message.result)
  }

  const handleStreamResponse = (
    message: ServerMessageTypePayload[ServerMessageType.RpcStreamResponse],
  ) => {
    const call = calls.get(message.callId)

    if (message.error) {
      if (call) rejectServerError(message.callId, call, message.error)
      return
    }

    // nothing is waiting for the stream anymore: tell the server to drop it
    if (!call) {
      sendAbort(message.callId)
      return
    }

    emitStreamResponse(message.callId, call)
    createRpcStream(message.callId, call)
  }

  core.on('message', (message) => {
    switch (message.type) {
      case ServerMessageType.RpcResponse:
        handleResponse(message)
        break
      case ServerMessageType.RpcStreamResponse:
        handleStreamResponse(message)
        break
      case ServerMessageType.RpcStreamChunk: {
        const credits = streamCredits.get(message.callId)
        if (!credits) break
        if (!credits.accept(1)) {
          abortStreamOnPushFailure(
            message.callId,
            STREAM_FLOW_CONTROL_VIOLATION_REASON,
          )
          break
        }

        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'push',
          callId: message.callId,
          byteLength: message.chunk.byteLength,
        })
        // push is intentionally not awaited: writes apply in arrival order
        // via the writable queue, and awaiting here would stall messages of
        // unrelated streams behind this one's backpressure
        rpcStreams
          .push(message.callId, message.chunk)
          .catch((error) => abortStreamOnPushFailure(message.callId, error))
        break
      }
      case ServerMessageType.RpcStreamEnd:
        release(message.callId)
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'end',
          callId: message.callId,
        })
        void rpcStreams.end(message.callId).catch(noopFn)
        break
      case ServerMessageType.RpcStreamAbort: {
        const call = release(message.callId)
        // an abort may arrive before the stream response was processed;
        // settle the still-pending call or it would hang forever (no-op if
        // the call already resolved with a stream)
        call?.reject(
          new ProtocolError(
            ErrorCode.ClientRequestError,
            message.reason ?? 'RPC stream aborted',
          ),
        )
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'abort',
          callId: message.callId,
          reason: message.reason,
        })
        void rpcStreams.abort(message.callId, message.reason).catch(noopFn)
        break
      }
    }
  })

  core.on('disconnected', (reason) => {
    const error = new ProtocolError(ErrorCode.ConnectionError, 'Disconnected', {
      reason,
    })

    for (const call of calls.values()) {
      call.cleanup?.()
      call.reject(error)
    }
    calls.clear()
    streamCredits.clear()
    void rpcStreams.clear(error).catch(noopFn)
  })

  const dispatch = async (
    callId: number,
    call: Call,
    payload: any,
    callOptions: StreamCallOptions,
    stream: boolean,
  ) => {
    const { procedure, signal } = call

    // not awaited at all without autoConnect: the request must reach the
    // transport in the same tick the caller made it
    if (core.autoConnect) await connectIfNeeded(core, signal)

    if (signal.aborted) throw toAbortError(signal)

    onAbort(signal, () => {
      call.reject(toAbortError(signal))

      if (core.transportType === ConnectionType.Bidirectional) {
        sendAbort(callId, toReasonString(signal.reason))
      }
    })

    const transformed = transformer.encode(procedure, payload)

    if (core.transportType === ConnectionType.Bidirectional) {
      const sent = core.sendMessage(
        ClientMessageType.Rpc,
        { callId, procedure, payload: transformed },
        signal,
      )

      if (!sent) {
        throw new ProtocolError(
          ErrorCode.ConnectionError,
          'Client is not connected',
        )
      }

      await sent
      return
    }

    const blob =
      transformed instanceof ProtocolBlob
        ? { source: transformed.source, metadata: transformed.metadata }
        : undefined

    const encoded =
      blob || transformed === undefined
        ? new Uint8Array(0)
        : core.codec.encode(transformed)

    const response = await core.transportCall(
      {
        application: core.application,
        auth: core.auth,
        contentType: core.codec.contentType,
      },
      { callId, procedure, payload: encoded, blob },
      { signal, streamResponse: stream, keepalive: callOptions.keepalive },
    )

    handleCallResponse(callId, response)
  }

  const callInternal = async (
    procedure: string,
    payload: any,
    callOptions: StreamCallOptions = {},
    stream = false,
  ): Promise<any> => {
    const requestedWindow = callOptions.backpressure?.rpc?.window
    const streamWindow =
      requestedWindow === undefined
        ? defaultWindow
        : validateStreamWindow(requestedWindow)
    const timeout = callOptions.timeout ?? options.timeout
    const controller = new AbortController()

    const signals: AbortSignal[] = [controller.signal]

    if (timeout) signals.push(AbortSignal.timeout(timeout))
    if (callOptions.signal) signals.push(callOptions.signal)
    if (core.connectionSignal) signals.push(core.connectionSignal)

    const signal = anyAbortSignal(...signals)
    const callId = nextCallId()
    const call: Call = { ...createFuture(), procedure, signal, streamWindow }

    calls.set(callId, call)
    core.emitClientEvent({
      kind: 'rpc_request',
      callId,
      procedure,
      body: payload,
    })

    if (signal.aborted) {
      call.reject(toAbortError(signal))
    } else {
      try {
        await dispatch(callId, call, payload, callOptions, stream)
      } catch (error) {
        emitError(callId, procedure, error)
        call.reject(error)
      }
    }

    try {
      const value = await call.promise

      if (value instanceof ProtocolServerRPCStream) {
        const managed = createManagedAsyncIterable(value, {
          onDone: () => {
            streamCredits.delete(callId)
            call.cleanup?.()
          },
          onReturn: (reason) => {
            controller.abort(reason)
          },
          onThrow: (error) => {
            controller.abort(error)
          },
        })

        if (!callOptions.autoReconnect) return managed

        return reconnectingAsyncIterable(
          core,
          managed,
          () =>
            callInternal(
              procedure,
              payload,
              { ...callOptions, autoReconnect: false },
              stream,
            ),
          callOptions.signal,
        )
      }

      // a blob outlives its call: aborting here would cancel the transfer
      // the caller is about to read
      if (isBlobInterface(value)) return value

      controller.abort()
      return value
    } catch (error) {
      controller.abort()
      throw error
    } finally {
      calls.delete(callId)
    }
  }

  return {
    async call(procedure, payload, callOptions = {}, params = {}) {
      const stream = params.stream ?? false

      if (!options.safe) {
        return callInternal(procedure, payload, callOptions, stream)
      }

      try {
        return {
          result: await callInternal(procedure, payload, callOptions, stream),
        }
      } catch (error) {
        return { error }
      }
    },
  }
}
