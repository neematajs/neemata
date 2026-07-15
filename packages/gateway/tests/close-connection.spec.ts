import { Hooks } from '@nmtjs/core'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { GATEWAY_TEARDOWN_STEP_TIMEOUT, Gateway } from '../src/gateway.ts'
import {
  createTestContainer,
  createTestLogger,
  createTestServerFormat,
} from './_helpers/test-utils.ts'

const createGateway = (
  transportOverrides: Record<string, any> = {},
  gatewayOverrides: Record<string, any> = {},
) => {
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
    ...gatewayOverrides,
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

  it('stop() waits for a teardown claimed by a concurrent caller', async () => {
    let resolveClose!: () => void
    const { gateway, connect, getParams } = createGateway({
      close: vi.fn(
        () => new Promise<void>((resolve) => (resolveClose = resolve)),
      ),
    })

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    // Disconnect claims the teardown and parks on transport.close
    const disconnect = getParams().onDisconnect(connection.id)

    let stopped = false
    const stop = gateway.stop().then(() => {
      stopped = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    expect(disposeSpy).not.toHaveBeenCalled()

    resolveClose()
    await Promise.all([disconnect, stop])

    expect(stopped).toBe(true)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('completes teardown and stop() when transport.close never settles', async () => {
    vi.useFakeTimers()

    const { gateway, connect, getParams } = createGateway({
      close: vi.fn(() => new Promise<void>(() => {})),
    })

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    const disconnect = getParams().onDisconnect(connection.id)
    let stopped = false
    const stop = gateway.stop().then(() => {
      stopped = true
    })

    // The step timeout abandons the hung close and teardown moves on
    await vi.advanceTimersByTimeAsync(GATEWAY_TEARDOWN_STEP_TIMEOUT)
    await Promise.all([disconnect, stop])

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(true)

    vi.useRealTimers()
  })

  it('heartbeat timeout racing disconnect closes and disposes exactly once', async () => {
    vi.useFakeTimers()

    const { gateway, transport, connect, getParams } = createGateway(
      {},
      { heartbeat: { interval: 1000, timeout: 500 } },
    )

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    // Ping goes out, then a transport disconnect races the pending heartbeat:
    // stopping the heartbeat rejects the pending Pong future, sending the
    // heartbeat loop into its timeout path against the claimed teardown
    await vi.advanceTimersByTimeAsync(1000)
    const disconnect = getParams().onDisconnect(connection.id)
    await vi.advanceTimersByTimeAsync(500)
    await disconnect

    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)

    vi.useRealTimers()
  })
})
