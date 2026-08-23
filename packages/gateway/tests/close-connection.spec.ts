import { Hooks } from '@nmtjs/core'
import { ProtocolBlob } from '@nmtjs/protocol'
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

  it.each([
    ['ProtocolBlob', () => ProtocolBlob.from('body')],
    ['Response', () => new Response('body')],
  ])(
    'keeps the %s call scope alive and disposes it before the connection scope',
    async (_label, createResult) => {
      const events: string[] = []
      const { gateway, connect, getParams } = createGateway({
        call: async () => createResult(),
      })
      const connection = await connect()
      const originalFork = connection.container.fork.bind(connection.container)
      const callDispose = vi.fn(async () => {
        events.push('call')
      })
      vi.spyOn(connection.container, 'fork').mockImplementation((scope) => {
        const callContainer = originalFork(scope)
        vi.spyOn(callContainer, 'dispose').mockImplementation(callDispose)
        return callContainer
      })
      const connectionDispose = vi
        .spyOn(connection.container, 'dispose')
        .mockImplementation(async () => {
          events.push('connection')
        })

      await getParams().onRpc(
        connection,
        { procedure: 'test', payload: {} },
        new AbortController().signal,
      )

      expect(callDispose).not.toHaveBeenCalled()
      await getParams().onDisconnect(connection.id)

      expect(callDispose).toHaveBeenCalledOnce()
      expect(connectionDispose).toHaveBeenCalledOnce()
      expect(events).toEqual(['call', 'connection'])

      await gateway.stop()
    },
  )

  it('tracks an asynchronous stream onDone disposer before parent disposal', async () => {
    const events: string[] = []
    const { gateway, connect, getParams } = createGateway({
      call: async () => (onDone: () => Promise<void>) =>
        (async function* () {
          try {
            yield 'event'
          } finally {
            await onDone()
          }
        })(),
    })
    const connection = await connect()
    const originalFork = connection.container.fork.bind(connection.container)
    let releaseCallDispose!: () => void
    const callDispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push('call:start')
          releaseCallDispose = () => {
            events.push('call:end')
            resolve()
          }
        }),
    )
    vi.spyOn(connection.container, 'fork').mockImplementation((scope) => {
      const callContainer = originalFork(scope)
      vi.spyOn(callContainer, 'dispose').mockImplementation(callDispose)
      return callContainer
    })
    const connectionDispose = vi
      .spyOn(connection.container, 'dispose')
      .mockImplementation(async () => {
        events.push('connection')
      })

    const iterable = (await getParams().onRpc(
      connection,
      { procedure: 'test', payload: {} },
      new AbortController().signal,
    )) as AsyncIterable<string>
    expect(callDispose).not.toHaveBeenCalled()
    const iterator = iterable[Symbol.asyncIterator]()
    await iterator.next()

    const finish = iterator.return!()
    await vi.waitFor(() => expect(callDispose).toHaveBeenCalledOnce())
    const disconnect = getParams().onDisconnect(connection.id)
    await new Promise((resolve) => setImmediate(resolve))

    expect(connectionDispose).not.toHaveBeenCalled()
    releaseCallDispose()
    await Promise.all([finish, disconnect])

    expect(events).toEqual(['call:start', 'call:end', 'connection'])
    await gateway.stop()
  })
})
