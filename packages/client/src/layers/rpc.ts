import type { Future } from '@nmtjs/common'
import type { ServerMessageTypePayload } from '@nmtjs/protocol/client'
import { anyAbortSignal, createFuture, MAX_UINT32, noopFn } from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ProtocolBlob,
  ServerMessageType,
} from '@nmtjs/protocol'
import { ProtocolError, ProtocolServerRPCStream } from '@nmtjs/protocol/client'

import type { ClientCore } from '../core.ts'
import type { BaseClientTransformer } from '../transformers.ts'
import type { ClientCallOptions } from '../types.ts'
import type { StreamLayerApi } from './streams.ts'
import { ServerStreams } from '../streams.ts'

export type ProtocolClientCall = Future<any> & {
  procedure: string
  signal?: AbortSignal
  cleanup?: () => void
}

export interface RpcLayerApi {
  call(
    procedure: string,
    payload: any,
    options?: ClientCallOptions,
  ): Promise<any>
  readonly pendingCallCount: number
  readonly activeStreamCount: number
}

const toReasonString = (reason: unknown) => {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return undefined
  return String(reason)
}

const toAbortError = (signal: AbortSignal) => {
  return new ProtocolError(ErrorCode.ClientRequestError, String(signal.reason))
}

const waitForConnect = async (core: ClientCore, signal?: AbortSignal) => {
  if (!core.shouldConnectOnCall()) return

  if (signal?.aborted) {
    throw toAbortError(signal)
  }

  const connectPromise = core.connect()

  if (!signal) {
    await connectPromise
    return
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(toAbortError(signal))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    connectPromise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

const ensureConnectedForCall = async (
  core: ClientCore,
  signal?: AbortSignal,
) => {
  if (!core.autoConnect) return

  if (core.state !== 'connected') {
    await waitForConnect(core, signal)
  }

  if (core.state !== 'connected') {
    throw new ProtocolError(
      ErrorCode.ConnectionError,
      'Client is not connected',
    )
  }
}

const waitForConnected = (core: ClientCore, signal?: AbortSignal) => {
  if (core.state === 'connected') return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const offConnected = core.once('connected', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    })

    const onAbort = () => {
      offConnected()
      reject(signal?.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
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
        await waitForConnected(core, signal)
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
  options: { timeout?: number; safe?: boolean } = {},
): RpcLayerApi => {
  const calls = new Map<number, ProtocolClientCall>()
  const rpcStreams = new ServerStreams<ProtocolServerRPCStream>()

  let callId = 0

  const nextCallId = () => {
    if (callId >= MAX_UINT32) {
      callId = 0
    }

    return callId++
  }

  const handleRPCResponseMessage = (
    message: ServerMessageTypePayload[ServerMessageType.RpcResponse],
  ) => {
    const call = calls.get(message.callId)
    if (!call) return

    if (message.error) {
      core.emitClientEvent({
        kind: 'rpc_error',
        timestamp: Date.now(),
        callId: message.callId,
        procedure: call.procedure,
        error: message.error,
      })

      call.reject(
        new ProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      )
      return
    }

    try {
      const transformed = transformer.decode(call.procedure, message.result)
      core.emitClientEvent({
        kind: 'rpc_response',
        timestamp: Date.now(),
        callId: message.callId,
        procedure: call.procedure,
        body: transformed,
      })
      call.resolve(transformed)
    } catch (error) {
      core.emitClientEvent({
        kind: 'rpc_error',
        timestamp: Date.now(),
        callId: message.callId,
        procedure: call.procedure,
        error,
      })
      call.reject(
        new ProtocolError(
          ErrorCode.ClientRequestError,
          'Unable to decode response',
          error,
        ),
      )
    }
  }

  const handleRPCStreamResponseMessage = (
    message: ServerMessageTypePayload[ServerMessageType.RpcStreamResponse],
  ) => {
    const call = calls.get(message.callId)

    if (message.error) {
      if (!call) return

      core.emitClientEvent({
        kind: 'rpc_error',
        timestamp: Date.now(),
        callId: message.callId,
        procedure: call.procedure,
        error: message.error,
      })

      call.reject(
        new ProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      )
      return
    }

    if (!call) {
      if (!core.messageContext) return

      const buffer = core.protocol.encodeMessage(
        core.messageContext,
        ClientMessageType.RpcAbort,
        { callId: message.callId },
      )

      core.send(buffer).catch(noopFn)
      return
    }

    core.emitClientEvent({
      kind: 'rpc_response',
      timestamp: Date.now(),
      callId: message.callId,
      procedure: call.procedure,
      stream: true,
    })

    const { procedure, signal } = call
    const stream = new ProtocolServerRPCStream({
      start: (controller) => {
        if (!signal) return

        if (signal.aborted) {
          controller.error(signal.reason)
          return
        }

        const onAbort = () => {
          controller.error(signal.reason)

          if (rpcStreams.has(message.callId)) {
            void rpcStreams.abort(message.callId).catch(noopFn)
            if (core.messageContext) {
              const buffer = core.protocol.encodeMessage(
                core.messageContext,
                ClientMessageType.RpcAbort,
                {
                  callId: message.callId,
                  reason: toReasonString(signal.reason),
                },
              )
              core.send(buffer).catch(noopFn)
            }
          }
        }

        signal.addEventListener('abort', onAbort, { once: true })
        call.cleanup = () => {
          signal.removeEventListener('abort', onAbort)
        }
      },
      transform: (chunk) => {
        return transformer.decode(procedure, core.format.decode(chunk))
      },
      readableStrategy: { highWaterMark: 0 },
    })

    rpcStreams.add(message.callId, stream)
    call.resolve(stream)
  }

  const handleTransportErrorResponse = (
    callId: number,
    response: Extract<
      Awaited<ReturnType<ClientCore['transportCall']>>,
      { type: 'error' }
    >,
  ) => {
    const call = calls.get(callId)
    if (!call) return

    let error: ProtocolError

    try {
      const decoded = core.format.decode(response.error) as {
        code?: string
        message?: string
        data?: unknown
      }

      error = new ProtocolError(
        decoded.code || ErrorCode.ClientRequestError,
        decoded.message || response.statusText || 'Request failed',
        decoded.data,
      )
    } catch {
      error = new ProtocolError(
        ErrorCode.ClientRequestError,
        response.statusText
          ? `HTTP ${response.status ?? ''}: ${response.statusText}`.trim()
          : 'Request failed',
      )
    }

    core.emitClientEvent({
      kind: 'rpc_error',
      timestamp: Date.now(),
      callId,
      procedure: call.procedure,
      error,
    })

    call.reject(error)
  }

  const handleCallResponse = (
    currentCallId: number,
    response: Awaited<ReturnType<ClientCore['transportCall']>>,
  ) => {
    const call = calls.get(currentCallId)

    if (response.type === 'error') {
      handleTransportErrorResponse(currentCallId, response)
      return
    }

    if (response.type === 'rpc_stream') {
      if (!call) {
        response.stream.cancel().catch(noopFn)
        return
      }

      core.emitClientEvent({
        kind: 'rpc_response',
        timestamp: Date.now(),
        callId: currentCallId,
        procedure: call.procedure,
        stream: true,
      })

      const reader = response.stream.getReader()
      const { signal } = call
      let onAbort: (() => void) | undefined

      const stream = new ProtocolServerRPCStream({
        start: (controller) => {
          if (!signal) return

          onAbort = () => {
            controller.error(signal.reason)
            reader.cancel(signal.reason).catch(noopFn)
            void rpcStreams.abort(currentCallId).catch(noopFn)
          }

          if (signal.aborted) {
            onAbort()
          } else {
            signal.addEventListener('abort', onAbort, { once: true })
          }
        },
        transform: (chunk) => {
          return transformer.decode(call.procedure, core.format.decode(chunk))
        },
        readableStrategy: { highWaterMark: 0 },
      })

      rpcStreams.add(currentCallId, stream)
      call.resolve(stream)

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            await rpcStreams.push(currentCallId, value)
          }
          await rpcStreams.end(currentCallId)
        } catch {
          await rpcStreams.abort(currentCallId).catch(noopFn)
        } finally {
          reader.releaseLock()
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort)
          }
        }
      })()

      return
    }

    if (response.type === 'blob') {
      if (!call) {
        response.source.cancel().catch(noopFn)
        return
      }

      core.emitClientEvent({
        kind: 'rpc_response',
        timestamp: Date.now(),
        callId: currentCallId,
        procedure: call.procedure,
        stream: true,
      })

      const { blob } = streams.addServerBlobStream(response.metadata, {
        start: (stream, { signal } = {}) => {
          response.source.pipeTo(stream.writable, { signal }).catch(noopFn)
        },
      })
      call.resolve(blob)
      return
    }

    if (!call) return

    try {
      const decodedPayload =
        response.result.byteLength === 0
          ? undefined
          : core.format.decode(response.result)

      const transformed = transformer.decode(call.procedure, decodedPayload)
      core.emitClientEvent({
        kind: 'rpc_response',
        timestamp: Date.now(),
        callId: currentCallId,
        procedure: call.procedure,
        body: transformed,
      })
      call.resolve(transformed)
    } catch (error) {
      core.emitClientEvent({
        kind: 'rpc_error',
        timestamp: Date.now(),
        callId: currentCallId,
        procedure: call.procedure,
        error,
      })
      call.reject(
        new ProtocolError(
          ErrorCode.ClientRequestError,
          'Unable to decode response',
          error,
        ),
      )
    }
  }

  core.on('message', (message: any) => {
    switch (message.type) {
      case ServerMessageType.RpcResponse:
        handleRPCResponseMessage(message)
        break
      case ServerMessageType.RpcStreamResponse:
        handleRPCStreamResponseMessage(message)
        break
      case ServerMessageType.RpcStreamChunk:
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'push',
          callId: message.callId,
          byteLength: message.chunk.byteLength,
        })
        void rpcStreams.push(message.callId, message.chunk)
        break
      case ServerMessageType.RpcStreamEnd:
        calls.get(message.callId)?.cleanup?.()
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'end',
          callId: message.callId,
        })
        void rpcStreams.end(message.callId)
        calls.delete(message.callId)
        break
      case ServerMessageType.RpcStreamAbort:
        calls.get(message.callId)?.cleanup?.()
        core.emitStreamEvent({
          direction: 'incoming',
          streamType: 'rpc',
          action: 'abort',
          callId: message.callId,
          reason: message.reason,
        })
        void rpcStreams.abort(message.callId)
        calls.delete(message.callId)
        break
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
    void rpcStreams.clear(error).catch(noopFn)
  })

  const callInternal = async (
    procedure: string,
    payload: any,
    callOptions: ClientCallOptions = {},
  ) => {
    const timeout = callOptions.timeout ?? options.timeout
    const controller = new AbortController()

    const signals: AbortSignal[] = [controller.signal]

    if (timeout) signals.push(AbortSignal.timeout(timeout))
    if (callOptions.signal) signals.push(callOptions.signal)
    if (core.connectionSignal) signals.push(core.connectionSignal)

    const signal = signals.length ? anyAbortSignal(...signals) : undefined
    const currentCallId = nextCallId()
    const call = createFuture() as ProtocolClientCall
    call.procedure = procedure
    call.signal = signal

    calls.set(currentCallId, call)
    core.emitClientEvent({
      kind: 'rpc_request',
      timestamp: Date.now(),
      callId: currentCallId,
      procedure,
      body: payload,
    })

    if (signal?.aborted) {
      call.reject(toAbortError(signal))
    } else {
      try {
        if (core.autoConnect) {
          await ensureConnectedForCall(core, signal)
        }

        if (signal?.aborted) {
          throw toAbortError(signal)
        }

        signal?.addEventListener(
          'abort',
          () => {
            call.reject(toAbortError(signal))

            if (
              core.transportType === ConnectionType.Bidirectional &&
              core.messageContext
            ) {
              const buffer = core.protocol.encodeMessage(
                core.messageContext,
                ClientMessageType.RpcAbort,
                {
                  callId: currentCallId,
                  reason: toReasonString(signal.reason),
                },
              )
              core.send(buffer).catch(noopFn)
            }
          },
          { once: true },
        )

        const transformedPayload = transformer.encode(procedure, payload)

        if (core.transportType === ConnectionType.Bidirectional) {
          if (!core.messageContext) {
            throw new ProtocolError(
              ErrorCode.ConnectionError,
              'Client is not connected',
            )
          }

          const buffer = core.protocol.encodeMessage(
            core.messageContext,
            ClientMessageType.Rpc,
            { callId: currentCallId, procedure, payload: transformedPayload },
          )

          await core.send(buffer, signal)
        } else {
          const blob =
            transformedPayload instanceof ProtocolBlob
              ? {
                  source: transformedPayload.source,
                  metadata: transformedPayload.metadata,
                }
              : undefined

          const encodedPayload = blob
            ? new Uint8Array(0)
            : transformedPayload === undefined
              ? new Uint8Array(0)
              : core.format.encode(transformedPayload)

          const response = await core.transportCall(
            {
              application: core.application,
              auth: core.auth,
              contentType: core.format.contentType,
            },
            { callId: currentCallId, procedure, payload: encodedPayload, blob },
            { signal, streamResponse: callOptions._stream_response },
          )

          handleCallResponse(currentCallId, response)
        }
      } catch (error) {
        core.emitClientEvent({
          kind: 'rpc_error',
          timestamp: Date.now(),
          callId: currentCallId,
          procedure,
          error,
        })
        call.reject(error)
      }
    }

    return call.promise
      .then((value) => {
        if (value instanceof ProtocolServerRPCStream) {
          const stream = createManagedAsyncIterable(value, {
            onDone: () => {
              call.cleanup?.()
            },
            onReturn: (reason) => {
              controller.abort(reason)
            },
            onThrow: (error) => {
              controller.abort(error)
            },
          })

          if (callOptions.autoReconnect) {
            return reconnectingAsyncIterable(
              core,
              stream,
              () =>
                callInternal(procedure, payload, {
                  ...callOptions,
                  autoReconnect: false,
                }),
              callOptions.signal,
            )
          }

          return stream
        }

        controller.abort()
        return value
      })
      .catch((error) => {
        controller.abort()
        throw error
      })
      .finally(() => {
        calls.delete(currentCallId)
      })
  }

  return {
    async call(procedure, payload, callOptions = {}) {
      if (!options.safe) {
        return callInternal(procedure, payload, callOptions)
      }

      return callInternal(procedure, payload, callOptions)
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
    },
    get pendingCallCount() {
      return calls.size
    },
    get activeStreamCount() {
      return rpcStreams.size
    },
  }
}
