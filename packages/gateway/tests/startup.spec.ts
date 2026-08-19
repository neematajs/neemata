import { Hooks } from '@nmtjs/core'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { describe, expect, it, vi } from 'vitest'

import { ProxyableTransportType } from '../src/enums.ts'
import { Gateway } from '../src/gateway.ts'
import {
  createTestContainer,
  createTestLogger,
  createTestServerFormat,
} from './_helpers/test-utils.ts'

function createGateway(
  transports: ConstructorParameters<typeof Gateway>[0]['transports'],
) {
  const logger = createTestLogger()
  return new Gateway({
    logger,
    container: createTestContainer({ logger }),
    hooks: new Hooks(),
    formats: new ProtocolFormats([createTestServerFormat()]),
    transports,
    api: {
      resolve: vi.fn(),
      call: vi.fn(),
    },
    heartbeat: false,
  })
}

describe('Gateway transport lifecycle', () => {
  it('reports several proxy protocols for one transport URL', async () => {
    const transport = {
      start: vi.fn(async () => 'http://127.0.0.1:3000'),
      stop: vi.fn(async () => {}),
    }
    const gateway = createGateway({
      server: {
        transport,
        proxyable: [
          ProxyableTransportType.HTTP,
          ProxyableTransportType.WS,
          ProxyableTransportType.HTTP,
        ],
      },
    })

    await expect(gateway.start()).resolves.toStrictEqual([
      {
        type: ProxyableTransportType.HTTP,
        url: 'http://127.0.0.1:3000',
      },
      { type: ProxyableTransportType.WS, url: 'http://127.0.0.1:3000' },
    ])
    await gateway.stop()
  })

  it('starts transports in insertion order and stops them in reverse', async () => {
    const events: string[] = []
    const transport = (name: string) => ({
      async start() {
        events.push(`start:${name}`)
        return `${name}://`
      },
      async stop() {
        events.push(`stop:${name}`)
      },
    })
    const gateway = createGateway({
      first: { transport: transport('first') },
      second: { transport: transport('second') },
    })

    await gateway.start()
    await gateway.stop()

    expect(events).toStrictEqual([
      'start:first',
      'start:second',
      'stop:second',
      'stop:first',
    ])
  })

  it('stops already-started transports in reverse order on failure', async () => {
    const events: string[] = []
    const transport = (name: string, error?: Error) => ({
      async start() {
        events.push(`start:${name}`)
        if (error) throw error
        return `${name}://`
      },
      async stop() {
        events.push(`stop:${name}`)
      },
    })
    const failure = new Error('bind failed')
    const gateway = createGateway({
      first: { transport: transport('first') },
      second: { transport: transport('second') },
      third: { transport: transport('third', failure) },
    })

    await expect(gateway.start()).rejects.toBe(failure)
    expect(events).toStrictEqual([
      'start:first',
      'start:second',
      'start:third',
      'stop:second',
      'stop:first',
    ])
  })

  it('aggregates the start failure with rollback errors when a stop also throws', async () => {
    const startFailure = new Error('bind failed')
    const stopFailure = new Error('stop failed')
    const gateway = createGateway({
      first: {
        transport: {
          start: vi.fn(async () => 'first://'),
          stop: vi.fn(async () => {
            throw stopFailure
          }),
        },
      },
      second: {
        transport: {
          start: vi.fn(async () => {
            throw startFailure
          }),
          stop: vi.fn(async () => {}),
        },
      },
    })

    const error = await gateway.start().then(
      () => {
        throw new Error('start should have rejected')
      },
      (error) => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe(
      'Failed to start gateway and roll back transports',
    )
    expect(error.errors).toStrictEqual([startFailure, stopFailure])
  })
})
