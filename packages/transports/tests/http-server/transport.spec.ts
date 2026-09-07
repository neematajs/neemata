import { ProxyableTransportType } from '@nmtjs/gateway'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ServerHandler } from '../../src/http-server/transport.ts'
import type { ServerHost } from '../../src/http-server/types.ts'
import { createServerTransport } from '../../src/http-server/transport.ts'

describe('server transport handlers', () => {
  it('requires at least one handler', () => {
    const { host } = createHost()
    expect(() =>
      createServerTransport({ host: () => host, handlers: {} }),
    ).toThrow('requires at least one handler')
  })

  it('infers keyed options and owns the host lifecycle', async () => {
    const { host, startHost, stopHost } = createHost()
    const events: string[] = []
    let wsGateway: any

    const http: ServerHandler<
      { cors: boolean },
      {},
      readonly [ProxyableTransportType.HTTP]
    > = {
      proxyable: [ProxyableTransportType.HTTP],
      mount(_context, options) {
        events.push(`mount:http:${options.cors}`)
        return {
          dispose: () => {
            events.push('dispose:http')
          },
        }
      },
    }
    const ws: ServerHandler<
      { path: `/${string}` },
      {},
      readonly [ProxyableTransportType.WS]
    > = {
      proxyable: [ProxyableTransportType.WS],
      mount({ gateway }, options) {
        wsGateway = gateway
        events.push(`mount:ws:${options.path}`)
        return {
          dispose: () => {
            events.push('dispose:ws')
          },
        }
      },
    }

    const Server = createServerTransport({
      host: () => host,
      handlers: { anything: http, realtime: ws },
    })
    expect(Server.proxyable).toStrictEqual([
      ProxyableTransportType.HTTP,
      ProxyableTransportType.WS,
    ])
    type Options = Parameters<typeof Server.factory>[0]
    expectTypeOf<Options['handlers']['anything']>().toEqualTypeOf<{
      cors: boolean
    }>()
    expectTypeOf<Options['handlers']['realtime']>().toEqualTypeOf<{
      path: `/${string}`
    }>()

    const worker = await Server.factory({
      listen: { port: 0 },
      handlers: {
        anything: { cors: true },
        realtime: { path: '/ws' },
      },
    })
    const params = createParams()
    await expect(worker.start(params)).resolves.toBe('http://127.0.0.1:3000')
    expect(startHost).toHaveBeenCalledOnce()

    // handlers receive the gateway surface untouched — no interposed routing
    expect(wsGateway).toBe(params)

    await worker.stop()
    expect(stopHost).toHaveBeenCalledOnce()
    expect(events).toStrictEqual([
      'mount:http:true',
      'mount:ws:/ws',
      'dispose:ws',
      'dispose:http',
    ])
  })

  it('serializes overlapping lifecycle calls and disposes before host stop', async () => {
    const events: string[] = []
    let releaseMount!: () => void
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve
    })
    const { host, startHost, stopHost } = createHost()
    startHost.mockImplementation(async () => {
      events.push('start:host')
      return 'http://127.0.0.1:3000'
    })
    stopHost.mockImplementation(async () => {
      events.push('stop:host')
    })
    const handler: ServerHandler<{}> = {
      proxyable: [],
      async mount() {
        events.push('mount:handler')
        await mountGate
        return {
          dispose() {
            events.push('dispose:handler')
          },
        }
      },
    }
    const Server = createServerTransport({
      host: () => host,
      handlers: { handler },
    })
    const worker = await Server.factory({
      listen: { port: 0 },
      handlers: { handler: {} },
    })
    const params = createParams()

    const firstStart = worker.start(params)
    const overlappingStart = worker.start(params)
    const firstStop = worker.stop()
    const overlappingStop = worker.stop()
    releaseMount()

    await expect(firstStart).resolves.toBe('http://127.0.0.1:3000')
    await expect(overlappingStart).rejects.toThrow(
      'The server transport is already started',
    )
    await Promise.all([firstStop, overlappingStop])
    expect(events).toStrictEqual([
      'mount:handler',
      'start:host',
      'dispose:handler',
      'stop:host',
    ])
  })

  it('rolls back a failed start and can be started again', async () => {
    const events: string[] = []
    const failure = new Error('second handler failed')
    const bindFailure = new Error('host failed to bind')
    let failMount = true
    const { host, startHost, stopHost } = createHost()
    const first: ServerHandler<{}> = {
      proxyable: [],
      mount() {
        events.push('mount:first')
        return {
          dispose() {
            events.push('dispose:first')
          },
        }
      },
    }
    const second: ServerHandler<{}> = {
      proxyable: [],
      mount() {
        events.push('mount:second')
        if (failMount) {
          failMount = false
          throw failure
        }
        return {
          dispose() {
            events.push('dispose:second')
          },
        }
      },
    }
    const Server = createServerTransport({
      host: () => host,
      handlers: { first, second },
    })
    const worker = await Server.factory({
      listen: { port: 0 },
      handlers: { first: {}, second: {} },
    })
    const params = createParams()

    // the original mount error surfaces bare because the rollback succeeded
    await expect(worker.start(params)).rejects.toBe(failure)
    expect(events).toStrictEqual([
      'mount:first',
      'mount:second',
      'dispose:first',
    ])
    expect(stopHost).toHaveBeenCalledOnce()
    expect(startHost).not.toHaveBeenCalled()

    startHost.mockRejectedValueOnce(bindFailure)
    await expect(worker.start(params)).rejects.toBe(bindFailure)
    expect(events).toStrictEqual([
      'mount:first',
      'mount:second',
      'dispose:first',
      'mount:first',
      'mount:second',
      'dispose:second',
      'dispose:first',
    ])
    expect(startHost).toHaveBeenCalledOnce()
    expect(stopHost).toHaveBeenCalledTimes(2)

    await expect(worker.start(params)).resolves.toBe('http://127.0.0.1:3000')
    await worker.stop()
    expect(events).toStrictEqual([
      'mount:first',
      'mount:second',
      'dispose:first',
      'mount:first',
      'mount:second',
      'dispose:second',
      'dispose:first',
      'mount:first',
      'mount:second',
      'dispose:second',
      'dispose:first',
    ])
    expect(startHost).toHaveBeenCalledTimes(2)
    expect(stopHost).toHaveBeenCalledTimes(3)
  })

  it('rejects conflicting injectable names but accepts the same token', () => {
    const first = {} as any
    const second = {} as any
    const handler = (injectable: any): ServerHandler => ({
      proxyable: [],
      injectables: { request: injectable },
      mount: () => ({ dispose() {} }),
    })
    const { host } = createHost()

    expect(() =>
      createServerTransport({
        host: () => host,
        handlers: { first: handler(first), second: handler(first) },
      }),
    ).not.toThrow()
    expect(() =>
      createServerTransport({
        host: () => host,
        handlers: { first: handler(first), second: handler(second) },
      }),
    ).toThrow('conflicts on injectable [request]')
  })
})

function createHost() {
  const startHost = vi.fn(async () => 'http://127.0.0.1:3000')
  const stopHost = vi.fn(async () => {})
  const host: ServerHost<'node'> = {
    runtime: 'node',
    native: {},
    maxRequestBodySize: 1024 * 1024 * 128,
    mountFetchHandler: vi.fn(() => () => {}),
    mountWebSocket: vi.fn(() => () => {}),
    isSendSuccess: vi.fn(() => true),
    start: startHost,
    stop: stopHost,
  }
  return { host, startHost, stopHost }
}

function createParams() {
  return {
    onConnect: vi.fn(async () => ({
      id: 'connection',
      [Symbol.asyncDispose]: async () => {},
    })),
    onDisconnect: vi.fn(async () => {}),
    resolve: vi.fn(),
    onRpc: vi.fn(),
  } as any
}
