import { Hooks } from '@nmtjs/core'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { Gateway } from '../src/gateway.ts'
import {
  createTestContainer,
  createTestLogger,
  createTestServerFormat,
} from './_helpers/test-utils.ts'

const createGateway = (transportOverrides: Record<string, any> = {}) => {
  const logger = createTestLogger()
  const container = createTestContainer({ logger })
  const serverFormat = createTestServerFormat()

  const api: GatewayApi = {
    resolve: vi.fn(async () => ({ name: 'close/test', stream: false })),
    call: vi.fn(async () => undefined),
  }

  let params: any

  const transport = {
    start: vi.fn(async (_params) => {
      params = _params
      return 'test://'
    }),
    stop: vi.fn(async () => {}),
    send: vi.fn((_connectionId: string, _buffer: ArrayBufferView) => true),
    close: vi.fn((_connectionId: string) => {}),
    ...transportOverrides,
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

  const connect = async () => {
    await gateway.start()
    return params.onConnect({
      type: ConnectionType.Bidirectional,
      protocolVersion: ProtocolVersion.v1,
      accept: serverFormat.contentType,
      contentType: serverFormat.contentType,
      data: {},
    })
  }

  return { gateway, transport, connect, getParams: () => params }
}

describe('Gateway closeConnection', () => {
  it('disposes exactly once for concurrent close calls', async () => {
    const { gateway, transport, connect, getParams } = createGateway({
      // Suspend teardown across an await point so both callers overlap
      close: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      ),
    })

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    await Promise.all([
      getParams().onDisconnect(connection.id),
      getParams().onDisconnect(connection.id),
    ])

    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)
  })

  it('still disposes container and aborts RPCs when transport.close throws', async () => {
    const { gateway, connect, getParams } = createGateway({
      close: vi.fn(async () => {
        throw new Error('close failed')
      }),
    })

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    const rpcController = new AbortController()
    gateway.rpcs.set(connection.id, 1, rpcController)

    await expect(
      getParams().onDisconnect(connection.id),
    ).resolves.toBeUndefined()

    expect(connection.abortController.signal.aborted).toBe(true)
    expect(rpcController.signal.aborted).toBe(true)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)
  })
})
