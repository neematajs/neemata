import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'

import { createFactoryInjectable, Hooks, Scope } from '@nmtjs/core'
import {
  ClientMessageType,
  ConnectionType,
  createProtocolBlobReference,
  ProtocolBlob,
  ProtocolVersion,
  ServerMessageType,
} from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { Gateway, gatewayLoggerOptions } from '../src/gateway.ts'
import {
  createTestContainer,
  createTestLogger,
  createTestServerFormat,
} from './_helpers/test-utils.ts'

const encodeRpcMessage = (callId: number, procedure: string, payload: any) => {
  const name = Buffer.from(procedure, 'utf-8')
  const header = Buffer.alloc(7)
  header.writeUInt8(ClientMessageType.Rpc, 0)
  header.writeUInt32LE(callId, 1)
  header.writeUInt16LE(name.byteLength, 5)
  return Buffer.concat([header, name, Buffer.from(JSON.stringify(payload))])
}

const encodeRpcAbortMessage = (callId: number) => {
  const buffer = Buffer.alloc(5)
  buffer.writeUInt8(ClientMessageType.RpcAbort, 0)
  buffer.writeUInt32LE(callId, 1)
  return buffer
}

const decodeRpcResponse = (buffer: Buffer) => ({
  type: buffer.readUInt8(0),
  callId: buffer.readUInt32LE(1),
  isError: buffer.readUInt8(5) === 1,
  payload: JSON.parse(buffer.subarray(6).toString('utf-8')),
})

async function createTestGateway() {
  const logger = createTestLogger()
  const container = createTestContainer({ logger })
  const serverFormat = createTestServerFormat()

  // each api.call stays in flight until its future is resolved by the test
  const calls: PromiseWithResolvers<unknown>[] = []
  const api: GatewayApi = {
    resolve: vi.fn(async () => ({ name: 'test', stream: false })),
    call: vi.fn(() => {
      const future = Promise.withResolvers<unknown>()
      calls.push(future)
      return future.promise
    }),
  }

  let params: any
  const sent: Buffer[] = []

  const transport = {
    start: vi.fn(async (_params) => {
      params = _params
      return 'test://'
    }),
    stop: vi.fn(async () => {}),
    send: vi.fn((_connectionId: string, buffer: ArrayBufferView) => {
      sent.push(Buffer.from(buffer as Uint8Array))
      return true
    }),
    close: vi.fn((_connectionId: string) => {}),
  }

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    formats: new ProtocolFormats([serverFormat]),
    transports: { test: { transport } },
    api,
    heartbeat: false,
  })

  await gateway.start()

  const connection = await params.onConnect({
    type: ConnectionType.Bidirectional,
    protocolVersion: ProtocolVersion.v1,
    accept: serverFormat.contentType,
    contentType: serverFormat.contentType,
    data: {},
  })

  const send = (data: Buffer) =>
    params.onMessage({ connectionId: connection.id, data })

  return { gateway, api, calls, sent, connection, send }
}

describe('Gateway RPC handling', () => {
  it('drops a duplicate callId without disturbing the in-flight call', async () => {
    const { gateway, api, calls, sent, connection, send } =
      await createTestGateway()

    // First call stays in flight (api.call promise unresolved)
    const inFlight = send(encodeRpcMessage(1, 'test', {}))

    const controller = gateway.rpcs.get(connection.id, 1)
    expect(controller).toBeDefined()

    // Hostile reuse of the same callId must produce NO response: an error
    // response would reject the pending call on the client side
    await send(encodeRpcMessage(1, 'test', {}))

    expect(api.call).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(0)

    // Original call survives: same controller, not aborted, responds normally
    expect(gateway.rpcs.get(connection.id, 1)).toBe(controller)
    expect(controller!.signal.aborted).toBe(false)

    calls[0].resolve({ ok: true })
    await inFlight

    expect(sent.length).toBe(1)
    const response = decodeRpcResponse(sent[0])
    expect(response.type).toBe(ServerMessageType.RpcResponse)
    expect(response.callId).toBe(1)
    expect(response.isError).toBe(false)
    expect(response.payload).toStrictEqual({ ok: true })

    await gateway.stop()
  })

  it('keeps an aborted callId reserved until the handler finishes', async () => {
    const { gateway, api, calls, sent, connection, send } =
      await createTestGateway()

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    const controller = gateway.rpcs.get(connection.id, 1)

    // Abort-ignoring handler: the call promise stays pending after abort
    await send(encodeRpcAbortMessage(1))
    expect(controller!.signal.aborted).toBe(true)

    // Immediate reuse must still be dropped, or the old context's disposal
    // would remove the new call's controller
    await send(encodeRpcMessage(1, 'test', {}))
    expect(api.call).toHaveBeenCalledTimes(1)
    expect(gateway.rpcs.get(connection.id, 1)).toBe(controller)

    // Once the original call truly finishes, the id becomes reusable
    calls[0].resolve(null)
    await inFlight
    expect(gateway.rpcs.get(connection.id, 1)).toBeUndefined()

    const inFlight2 = send(encodeRpcMessage(1, 'test', {}))
    expect(api.call).toHaveBeenCalledTimes(2)

    const controller2 = gateway.rpcs.get(connection.id, 1)
    expect(controller2).toBeDefined()
    expect(controller2).not.toBe(controller)
    expect(controller2!.signal.aborted).toBe(false)

    // ...and the new call is abortable via its own controller
    await send(encodeRpcAbortMessage(1))
    expect(controller2!.signal.aborted).toBe(true)

    calls[1].resolve(null)
    await inFlight2

    expect(sent.length).toBe(2)

    await gateway.stop()
  })
})

describe('Gateway HTTP onRpc call-scope lifetime', () => {
  async function createHttpGateway(call: (container: any) => Promise<unknown>) {
    const logger = createTestLogger()
    const container = createTestContainer({ logger })
    const serverFormat = createTestServerFormat()

    const api: GatewayApi = {
      resolve: vi.fn(async () => ({ name: 'test', stream: false })),
      call: vi.fn(async ({ container }) => await call(container)),
    }

    let params: any
    const transport = {
      start: vi.fn(async (_params) => {
        params = _params
        return 'test://'
      }),
      stop: vi.fn(async () => {}),
    }

    const gateway = new Gateway({
      logger,
      container,
      hooks: new Hooks(),
      formats: new ProtocolFormats([serverFormat]),
      transports: { test: { transport } },
      api,
      heartbeat: false,
    })

    await gateway.start()

    const connection = await params.onConnect({
      type: ConnectionType.Unidirectional,
      protocolVersion: ProtocolVersion.v1,
      accept: serverFormat.contentType,
      contentType: serverFormat.contentType,
      data: {},
    })

    return { gateway, params, connection }
  }

  const rpc = { callId: 0, payload: undefined, procedure: 'test' }

  it('keeps the call scope alive for blob results until connection teardown', async () => {
    const disposeSpy = vi.fn()
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: () => 'resource',
      dispose: disposeSpy,
    })

    const { gateway, params, connection } = await createHttpGateway(
      async (container) => {
        await container.resolve(callScoped)
        return ProtocolBlob.from('data')
      },
    )

    const result = await params.onRpc(
      connection,
      rpc,
      new AbortController().signal,
    )

    expect(result).toBeInstanceOf(ProtocolBlob)
    // the blob body streams after onRpc returns — disposing the call scope
    // here would kill DI-scoped sources mid-stream
    expect(disposeSpy).not.toHaveBeenCalled()

    await params.onDisconnect(connection.id)
    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledTimes(1))

    await gateway.stop()
  })

  it('keeps the call scope alive for streamed Response results until connection teardown', async () => {
    const disposeSpy = vi.fn()
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: () => 'resource',
      dispose: disposeSpy,
    })

    const { gateway, params, connection } = await createHttpGateway(
      async (container) => {
        await container.resolve(callScoped)
        // a handler-built Response whose body streams from a call-scoped
        // resource — same lifetime class as a blob download
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8))
              controller.close()
            },
          }),
        )
      },
    )

    const result = await params.onRpc(
      connection,
      rpc,
      new AbortController().signal,
    )

    expect(result).toBeInstanceOf(Response)
    expect(disposeSpy).not.toHaveBeenCalled()

    await params.onDisconnect(connection.id)
    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledTimes(1))

    await gateway.stop()
  })

  it('finishes deferred call-scope disposal before the connection container', async () => {
    const order: string[] = []
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: () => 'call',
      dispose: async () => {
        order.push('call:start')
        await delay(20)
        order.push('call:end')
      },
    })
    const connectionScoped = createFactoryInjectable({
      scope: Scope.Connection,
      create: () => 'connection',
      dispose: () => {
        order.push('connection')
      },
    })

    const { gateway, params, connection } = await createHttpGateway(
      async (container) => {
        await container.resolve(callScoped)
        await container.resolve(connectionScoped)
        return ProtocolBlob.from('data')
      },
    )

    await params.onRpc(connection, rpc, new AbortController().signal)
    await params.onDisconnect(connection.id)

    // a call-scoped disposer may still be using connection-scoped deps:
    // teardown must not dispose the connection container underneath it
    expect(order).toEqual(['call:start', 'call:end', 'connection'])

    await gateway.stop()
  })

  it('still disposes the call scope immediately for buffered results', async () => {
    const disposeSpy = vi.fn()
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: () => 'resource',
      dispose: disposeSpy,
    })

    const { gateway, params, connection } = await createHttpGateway(
      async (container) => {
        await container.resolve(callScoped)
        return { ok: true }
      },
    )

    await params.onRpc(connection, rpc, new AbortController().signal)

    expect(disposeSpy).toHaveBeenCalledTimes(1)

    await params.onDisconnect(connection.id)
    await gateway.stop()
  })
})

describe('Gateway logger payload serializer', () => {
  it('renders blob placeholders instead of traversing them as objects', () => {
    const serialize = gatewayLoggerOptions.serializers!.payload
    const blob = createProtocolBlobReference(1, { size: 3, type: 'text/plain' })

    const result = serialize({
      file: blob,
      list: [blob],
      nested: { value: 42 },
    })

    const placeholder = `<ClientBlobStream metadata=${JSON.stringify(blob.metadata)}>`
    expect(result.file).toBe(placeholder)
    expect(result.list).toStrictEqual([placeholder])
    expect(result.nested).toStrictEqual({ value: 42 })
  })
})
