import { Buffer } from 'node:buffer'

import { Hooks } from '@nmtjs/core'
import {
  ClientMessageType,
  ConnectionType,
  createProtocolBlobReference,
  ErrorCode,
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

const decodeRpcResponse = (buffer: Buffer) => ({
  type: buffer.readUInt8(0),
  callId: buffer.readUInt32LE(1),
  isError: buffer.readUInt8(5) === 1,
  payload: JSON.parse(buffer.subarray(6).toString('utf-8')),
})

describe('Gateway RPC handling', () => {
  it('rejects a duplicate callId without disturbing the in-flight call', async () => {
    const logger = createTestLogger()
    const container = createTestContainer({ logger })
    const serverFormat = createTestServerFormat()

    const firstCall = Promise.withResolvers<unknown>()
    const api: GatewayApi = {
      resolve: vi.fn(async () => ({ name: 'test', stream: false })),
      call: vi.fn(() => firstCall.promise),
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

    // First call stays in flight (api.call promise unresolved)
    const inFlight = params.onMessage({
      connectionId: connection.id,
      data: encodeRpcMessage(1, 'test', {}),
    })

    const controller = gateway.rpcs.get(connection.id, 1)
    expect(controller).toBeDefined()

    // Hostile reuse of the same callId
    await params.onMessage({
      connectionId: connection.id,
      data: encodeRpcMessage(1, 'test', {}),
    })

    expect(api.call).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(1)

    const rejection = decodeRpcResponse(sent[0])
    expect(rejection.type).toBe(ServerMessageType.RpcResponse)
    expect(rejection.callId).toBe(1)
    expect(rejection.isError).toBe(true)
    expect(rejection.payload).toMatchObject({
      code: ErrorCode.ClientRequestError,
    })

    // Original call survives: same controller, not aborted, responds normally
    expect(gateway.rpcs.get(connection.id, 1)).toBe(controller)
    expect(controller!.signal.aborted).toBe(false)

    firstCall.resolve({ ok: true })
    await inFlight

    expect(sent.length).toBe(2)
    const response = decodeRpcResponse(sent[1])
    expect(response.type).toBe(ServerMessageType.RpcResponse)
    expect(response.callId).toBe(1)
    expect(response.isError).toBe(false)
    expect(response.payload).toStrictEqual({ ok: true })

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
