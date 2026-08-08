import type { SendResult } from '@nmtjs/gateway'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { ConnectionType } from '@nmtjs/protocol'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ServerHandler } from '../src/transport.ts'
import type { ServerHost } from '../src/types.ts'
import { createServerTransport } from '../src/transport.ts'

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
    const wsSend = vi.fn((): SendResult => 'delivered')
    const wsClose = vi.fn()
    let wsGateway: any

    const http: ServerHandler<
      ConnectionType.Unidirectional,
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
      ConnectionType.Bidirectional,
      { path: `/${string}` },
      {},
      readonly [ProxyableTransportType.WS]
    > = {
      proxyable: [ProxyableTransportType.WS],
      mount({ gateway }, options) {
        wsGateway = gateway
        events.push(`mount:ws:${options.path}`)
        return {
          send: wsSend,
          close: wsClose,
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

    await wsGateway.onConnect({ type: ConnectionType.Bidirectional })
    const buffer = new Uint8Array([1])
    expect(worker.send?.('connection', buffer)).toBe('delivered')
    expect(wsSend).toHaveBeenCalledWith('connection', buffer)
    // a handler's 'unknown' verdict passes through untouched
    wsSend.mockReturnValueOnce('unknown')
    expect(worker.send?.('connection', buffer)).toBe('unknown')
    // an untracked connection cannot be delivered to
    expect(worker.send?.('untracked', buffer)).toBe('dropped')

    await worker.close?.('connection', { code: 1000, reason: 'done' })
    expect(wsClose).toHaveBeenCalledWith('connection', {
      code: 1000,
      reason: 'done',
    })
    // close released the ownership record, so later sends have no owner
    expect(worker.send?.('connection', buffer)).toBe('dropped')

    // a gateway disconnect releases ownership just like close does
    await wsGateway.onConnect({ type: ConnectionType.Bidirectional })
    expect(worker.send?.('connection', buffer)).toBe('delivered')
    await wsGateway.onDisconnect('connection')
    expect(params.onDisconnect).toHaveBeenCalledWith('connection')
    expect(worker.send?.('connection', buffer)).toBe('dropped')

    await worker.stop(params)
    expect(stopHost).toHaveBeenCalledOnce()
    expect(events).toStrictEqual([
      'mount:http:true',
      'mount:ws:/ws',
      'dispose:ws',
      'dispose:http',
    ])
  })

  it('drops sends for connections owned by a handler without send', async () => {
    const { host } = createHost()
    let gateway: any
    const handler: ServerHandler<ConnectionType, {}> = {
      proxyable: [],
      mount(context) {
        gateway = context.gateway
        return { dispose() {} }
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
    await worker.start(createParams())

    await gateway.onConnect({ type: ConnectionType.Bidirectional })
    expect(worker.send?.('connection', new Uint8Array([1]))).toBe('dropped')
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
    const handler: ServerHandler<ConnectionType, {}> = {
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
    const firstStop = worker.stop(params)
    const overlappingStop = worker.stop(params)
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
    const first: ServerHandler<ConnectionType, {}> = {
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
    const second: ServerHandler<ConnectionType, {}> = {
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
    await worker.stop(params)
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
    formats: {},
    onConnect: vi.fn(async () => ({
      id: 'connection',
      [Symbol.asyncDispose]: async () => {},
    })),
    onDisconnect: vi.fn(async () => {}),
    onMessage: vi.fn(async () => {}),
    resolve: vi.fn(),
    onRpc: vi.fn(),
  } as any
}
