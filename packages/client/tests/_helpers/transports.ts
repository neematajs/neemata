import type { TAnyRouterContract } from '@nmtjs/contract'
import type { BaseClientFormat } from '@nmtjs/protocol/client'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'

import type { BaseClientOptions } from '../../src/client.ts'
import type {
  TransportCallContext,
  TransportCallOptions,
  TransportConnectParams,
  TransportRpcParams,
} from '../../src/transport.ts'

export interface MockBidirectionalTransportControl {
  transport: {
    type: ConnectionType.Bidirectional
    connect(params: TransportConnectParams): Promise<void>
    disconnect(): Promise<void>
    send(
      message: ArrayBufferView,
      options: { signal?: AbortSignal },
    ): Promise<void>
  }
  factory: () => {
    type: ConnectionType.Bidirectional
    connect(params: TransportConnectParams): Promise<void>
    disconnect(): Promise<void>
    send(
      message: ArrayBufferView,
      options: { signal?: AbortSignal },
    ): Promise<void>
  }
  readonly params: TransportConnectParams | null
  simulateConnect(): void
  simulateDisconnect(reason?: 'server' | 'client' | string): void
  emitMessage(message: ArrayBufferView): void
  setConnectFail(fail: boolean, error?: Error): void
  rejectConnect(error: Error): void
}

export interface MockUnidirectionalTransportControl {
  transport: {
    type: ConnectionType.Unidirectional
    call(
      context: TransportCallContext,
      rpc: TransportRpcParams,
      options: TransportCallOptions,
    ): Promise<any>
  }
  factory: () => {
    type: ConnectionType.Unidirectional
    call(
      context: TransportCallContext,
      rpc: TransportRpcParams,
      options: TransportCallOptions,
    ): Promise<any>
  }
}

export const mockFormat: BaseClientFormat = {
  contentType: 'application/json',
  encode: (data) => new TextEncoder().encode(JSON.stringify(data)),
  decode: (data) =>
    JSON.parse(new TextDecoder().decode(data as ArrayBufferView)),
  encodeRPC: (data) => new TextEncoder().encode(JSON.stringify(data)),
  decodeRPC: (data) =>
    JSON.parse(new TextDecoder().decode(data as ArrayBufferView)),
} as BaseClientFormat

export const createBaseOptions = <
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
>(
  overrides: Partial<BaseClientOptions<RouterContract, SafeCall>> = {},
): BaseClientOptions<RouterContract, SafeCall> =>
  ({
    contract: (overrides.contract ?? ({} as RouterContract)) as RouterContract,
    protocol: ProtocolVersion.v1,
    format: mockFormat,
    ...overrides,
  }) as BaseClientOptions<RouterContract, SafeCall>

export const createMockBidirectionalTransport =
  (): MockBidirectionalTransportControl => {
    let connectHandler: TransportConnectParams | null = null
    let connectResolve: (() => void) | null = null
    let connectReject: ((error: Error) => void) | null = null
    let shouldFailConnect = false
    let connectError: Error | null = null

    const transport = {
      type: ConnectionType.Bidirectional as const,
      connect: async (params: TransportConnectParams) => {
        connectHandler = params
        return new Promise<void>((resolve, reject) => {
          connectResolve = resolve
          connectReject = reject
          if (shouldFailConnect) {
            reject(connectError ?? new Error('Connection failed'))
          }
        })
      },
      disconnect: async () => {
        connectHandler?.onDisconnect('client')
      },
      send: async (
        _message: ArrayBufferView,
        _options: { signal?: AbortSignal },
      ) => {},
    }

    return {
      transport,
      factory: () => transport,
      get params() {
        return connectHandler
      },
      simulateConnect: () => {
        if (connectResolve && connectHandler) {
          connectResolve()
          connectHandler.onConnect()
        }
      },
      simulateDisconnect: (reason: 'server' | 'client' | string = 'server') => {
        connectHandler?.onDisconnect(reason)
      },
      emitMessage: (message: ArrayBufferView) => {
        connectHandler?.onMessage(message)
      },
      setConnectFail: (fail: boolean, error?: Error) => {
        shouldFailConnect = fail
        connectError = error ?? null
      },
      rejectConnect: (error: Error) => {
        connectReject?.(error)
      },
    }
  }

export const createMockUnidirectionalTransport = (
  impl?: (
    context: TransportCallContext,
    rpc: TransportRpcParams,
    options: TransportCallOptions,
  ) => Promise<any>,
): MockUnidirectionalTransportControl => {
  const transport = {
    type: ConnectionType.Unidirectional as const,
    call: async (
      context: TransportCallContext,
      rpc: TransportRpcParams,
      options: TransportCallOptions,
    ) => {
      if (impl) {
        return impl(context, rpc, options)
      }

      return {
        type: 'rpc' as const,
        result: mockFormat.encode({
          ok: true,
          echoed: mockFormat.decode(rpc.payload),
        }),
      }
    },
  }

  return { transport, factory: () => transport }
}
