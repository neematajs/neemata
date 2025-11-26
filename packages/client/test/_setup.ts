import { Buffer } from 'node:buffer'

import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ErrorCode,
  ProtocolRPCResponse,
} from '@nmtjs/protocol'
import type {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from '@nmtjs/protocol/client'
import { c } from '@nmtjs/contract'
import {
  ConnectionType,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'
import { t } from '@nmtjs/type'
import { vi } from 'vitest'

import type { BaseClientOptions } from '../src/common.ts'
import type {
  ClientCallResponse,
  ClientTransport,
  ClientTransportFactory,
} from '../src/transport.ts'
import type { ClientCallOptions } from '../src/types.ts'
import { StaticClient } from '../src/clients/static.ts'
import { BaseClient } from '../src/common.ts'
import { BaseClientTransformer } from '../src/transformers.ts'

const staticContract = c.router({
  routes: {
    users: c.router({
      routes: {
        list: c.procedure({
          input: t.object({ take: t.number() }),
          output: t.object({}),
          stream: true,
        }),
      },
    }),
  },
})

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const toUint8 = (view: ArrayBufferView | ArrayBuffer) => {
  if (view instanceof Uint8Array) return view
  if (view instanceof ArrayBuffer) return new Uint8Array(view)
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

export class DummyFormat extends BaseClientFormat {
  contentType = 'test/static'

  encode(): ArrayBufferView {
    return new Uint8Array()
  }

  decode() {
    return undefined
  }

  encodeRPC() {
    return { buffer: new Uint8Array(), streams: {} }
  }

  decodeRPC() {
    return { result: undefined, streams: {} }
  }
}

export class RuntimeTestFormat extends BaseClientFormat {
  contentType = 'test/client'

  encode(data: unknown): ArrayBufferView {
    return textEncoder.encode(JSON.stringify(data))
  }

  decode(buffer: ArrayBufferView): unknown {
    return JSON.parse(textDecoder.decode(toUint8(buffer)))
  }

  encodeRPC(
    data: unknown,
    _context: EncodeRPCContext<ProtocolClientBlobStream>,
  ) {
    return { buffer: this.encode(data), streams: {} }
  }

  decodeRPC(
    buffer: ArrayBufferView,
    _context: DecodeRPCContext<ProtocolServerBlobStream>,
  ): ProtocolRPCResponse {
    return this.decode(buffer) as ProtocolRPCResponse
  }
}

export class TestRuntimeClient<
  SafeCall extends boolean = false,
> extends BaseClient<ClientTransportFactory<any, any>, any, SafeCall> {
  protected transformer = new BaseClientTransformer()

  get call() {
    return this.createProxy(Object.create(null), false) as any
  }

  get stream() {
    return this.createProxy(Object.create(null), true) as any
  }

  protected createProxy<T>(
    target: Record<string, unknown>,
    isStream: boolean,
    path: string[] = [],
  ) {
    return new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'then') return obj
        const newPath = [...path, String(prop)]
        const caller = (
          payload?: unknown,
          options?: Partial<ClientCallOptions>,
        ) => this._call(newPath.join('/'), payload, options)
        return this.createProxy(caller as any, isStream, newPath)
      },
    }) as T
  }

  callProcedure(procedure: string, payload?: unknown, signal?: AbortSignal) {
    return this._call(procedure, payload, { signal })
  }

  emitMessage(buffer: ArrayBufferView) {
    return this.onMessage(buffer)
  }

  pendingCallIds() {
    return Array.from(this.calls.keys())
  }
}

export const createStaticBidirectionalClient = () => {
  const format = new DummyFormat()
  const transportInstance: ClientTransport<ConnectionType.Bidirectional> = {
    type: ConnectionType.Bidirectional,
    disconnect: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  }
  const transport: ClientTransportFactory<ConnectionType.Bidirectional, void> =
    vi.fn(() => transportInstance)
  const options: BaseClientOptions<any, false> = {
    contract: staticContract as any,
    protocol: ProtocolVersion.v1,
    format,
  }
  const client = new StaticClient(options, transport, undefined)
  return { client, format, transport, transportInstance }
}

export const createStaticUnidirectionalClient = () => {
  const format = new DummyFormat()
  const call = vi.fn(async () =>
    Promise.resolve({
      type: 'rpc' as const,
      result: { ok: true } as any,
    } as ClientCallResponse),
  )
  const transportInstance: ClientTransport<ConnectionType.Unidirectional> = {
    type: ConnectionType.Unidirectional,
    call,
  }
  const transport: ClientTransportFactory<ConnectionType.Unidirectional, void> =
    vi.fn(() => transportInstance)
  const options: BaseClientOptions<any, false> = {
    contract: staticContract as any,
    protocol: ProtocolVersion.v1,
    format,
  }
  const client = new StaticClient(options, transport, undefined)
  return { client, format, call }
}

export const createRuntimeBidirectionalSetup = () => {
  const format = new RuntimeTestFormat()
  let connectParams:
    | Parameters<ClientTransport<ConnectionType.Bidirectional>['connect']>[0]
    | null = null

  const sendMock = vi.fn<
    (message: ArrayBufferView, options: ClientCallOptions) => Promise<void>
  >(async () => {})

  const instance: ClientTransport<ConnectionType.Bidirectional> = {
    type: ConnectionType.Bidirectional,
    connect: vi.fn(async (params) => {
      connectParams = params
    }),
    disconnect: vi.fn(async () => {}),
    send: sendMock,
  }

  const transport: ClientTransportFactory<ConnectionType.Bidirectional, void> =
    vi.fn(() => instance)

  const options: BaseClientOptions<any, false> = {
    contract: { routes: {} } as any,
    protocol: ProtocolVersion.v1,
    format,
  }

  const client = new TestRuntimeClient(options, transport, undefined)

  return {
    client,
    format,
    transport,
    instance,
    sendMock,
    connectParamsRef: () => connectParams,
  }
}

export const createRuntimeUnidirectionalClient = () => {
  const format = new RuntimeTestFormat()
  const call = vi.fn(async () =>
    Promise.resolve({
      type: 'rpc' as const,
      result: { ok: true } as any,
    } as ClientCallResponse),
  )
  const instance: ClientTransport<ConnectionType.Unidirectional> = {
    type: ConnectionType.Unidirectional,
    call,
  }
  const transport: ClientTransportFactory<ConnectionType.Unidirectional, void> =
    vi.fn(() => instance)
  const options: BaseClientOptions<any, false> = {
    contract: { routes: {} } as any,
    protocol: ProtocolVersion.v1,
    format,
  }
  const client = new TestRuntimeClient(options, transport, undefined)
  return { client, format, instance, call }
}

export const createUnidirectionalTransportMock = () => {
  const call = vi.fn(async () =>
    Promise.resolve({
      type: 'rpc' as const,
      result: undefined as any,
    } as ClientCallResponse),
  )
  const instance: ClientTransport<ConnectionType.Unidirectional> = {
    type: ConnectionType.Unidirectional,
    call,
  }
  const transport: ClientTransportFactory<ConnectionType.Unidirectional, void> =
    vi.fn(() => instance)
  return { transport, instance, call }
}

export const encodeRpcResponse = (
  format: RuntimeTestFormat,
  callId: number,
  result: unknown,
) => {
  const encoded = toUint8(
    format.encodeRPC(result, { addStream: vi.fn(), getStream: vi.fn() }).buffer,
  )
  const frame = Buffer.alloc(6 + encoded.byteLength)
  frame.writeUint8(ServerMessageType.RpcResponse, 0)
  frame.writeUint32LE(callId, 1)
  frame.writeUint8(0, 5)
  Buffer.from(encoded).copy(frame, 6)
  return new Uint8Array(frame)
}

export const encodeRpcError = (
  format: RuntimeTestFormat,
  callId: number,
  error: { code: ErrorCode; message: string },
) => {
  const encoded = toUint8(format.encode(error))
  const frame = Buffer.alloc(6 + encoded.byteLength)
  frame.writeUint8(ServerMessageType.RpcResponse, 0)
  frame.writeUint32LE(callId, 1)
  frame.writeUint8(1, 5)
  Buffer.from(encoded).copy(frame, 6)
  return new Uint8Array(frame)
}
