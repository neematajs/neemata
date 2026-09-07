import { Hooks } from '@nmtjs/core'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import { GATEWAY_TEARDOWN_STEP_TIMEOUT, Gateway } from '../src/gateway.ts'
import { createTestContainer, createTestLogger } from './_helpers/test-utils.ts'

const createGateway = (options?: { call?: GatewayApi['call'] }) => {
  const logger = createTestLogger()
  const container = createTestContainer({ logger })

  const api: GatewayApi = {
    resolve: vi.fn(async () => ({ name: 'close/test', stream: false })),
    call: vi.fn(options?.call ?? (async () => undefined)),
  }

  let params: any

  const transport = {
    start: vi.fn(async (_params: any) => {
      params = _params
      return 'test://'
    }),
    stop: vi.fn(async () => {}),
  }

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: { test: { transport } },
    api,
  })

  const connect = async () => {
    await gateway.start()
    return params.onConnect({ data: {} })
  }

  return { gateway, api, transport, connect, getParams: () => params }
}

describe('Gateway closeConnection', () => {
  it('disposes exactly once for concurrent close calls', async () => {
    const { gateway, connect, getParams } = createGateway()

    const connection = await connect()
    // Suspend teardown across an await point so both callers overlap
    const disposeSpy = vi
      .spyOn(connection.container, 'dispose')
      .mockImplementation(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      )

    await Promise.all([
      getParams().onDisconnect(connection.id),
      getParams().onDisconnect(connection.id),
    ])

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)

    await gateway.stop()
  })

  it('aborts outstanding calls and the connection signal on disconnect', async () => {
    let callSignal: AbortSignal | undefined
    const { gateway, connect, getParams } = createGateway({
      // abort-ignoring handler: never settles on its own
      call: async ({ signal }) => {
        callSignal = signal
        return new Promise(() => {})
      },
    })

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    void getParams().onRpc(
      connection,
      { procedure: 'test', payload: {} },
      new AbortController().signal,
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(callSignal).toBeDefined()
    expect(callSignal!.aborted).toBe(false)

    await getParams().onDisconnect(connection.id)

    expect(connection.abortController.signal.aborted).toBe(true)
    expect(callSignal!.aborted).toBe(true)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)

    await gateway.stop()
  })

  it('stop() waits for a teardown claimed by a concurrent caller', async () => {
    const { gateway, connect, getParams } = createGateway()

    const connection = await connect()
    let resolveDispose!: () => void
    const disposeSpy = vi
      .spyOn(connection.container, 'dispose')
      .mockImplementation(
        () => new Promise<void>((resolve) => (resolveDispose = resolve)),
      )

    // Disconnect claims the teardown and parks on container.dispose
    const disconnect = getParams().onDisconnect(connection.id)

    let stopped = false
    const stop = gateway.stop().then(() => {
      stopped = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)

    resolveDispose()
    await Promise.all([disconnect, stop])

    expect(stopped).toBe(true)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('completes teardown and stop() when container disposal never settles', async () => {
    vi.useFakeTimers()

    const { gateway, connect, getParams } = createGateway()

    const connection = await connect()
    const disposeSpy = vi
      .spyOn(connection.container, 'dispose')
      .mockImplementation(() => new Promise<void>(() => {}))

    const disconnect = getParams().onDisconnect(connection.id)
    let stopped = false
    const stop = gateway.stop().then(() => {
      stopped = true
    })

    // The step timeout abandons the hung disposal and teardown moves on
    await vi.advanceTimersByTimeAsync(GATEWAY_TEARDOWN_STEP_TIMEOUT)
    await Promise.all([disconnect, stop])

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(true)

    vi.useRealTimers()
  })

  it('sweeps connections whose transport never reported a disconnect on stop()', async () => {
    const { gateway, connect } = createGateway()

    const connection = await connect()
    const disposeSpy = vi.spyOn(connection.container, 'dispose')

    await gateway.stop()

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(gateway.connections.has(connection.id)).toBe(false)
  })
})
