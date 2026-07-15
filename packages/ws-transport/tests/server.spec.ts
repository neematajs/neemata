import type { Peer } from 'crossws'
import { describe, expect, it, vi } from 'vitest'

import type {
  WsAdapterServerFactory,
  WsTransportOptions,
} from '../src/types.ts'
import { WsTransport as BunWsTransport } from '../src/runtimes/bun.ts'
import { WsTransport as NodeWsTransport } from '../src/runtimes/node.ts'
import { WsTransportServer } from '../src/server.ts'

const adapterFactory: WsAdapterServerFactory<any> = () => ({
  start: vi.fn(async () => 'ws://localhost'),
  stop: vi.fn(async () => {}),
})

const options = { listen: { port: 0 } } as WsTransportOptions

const setPeer = (server: WsTransportServer, send: () => unknown) => {
  const peer = {
    send: vi.fn(send),
    close: vi.fn(),
    context: { connectionId: 'c1' },
  } as unknown as Peer
  server.clients.set('c1', peer)
  return server
}

describe('WsTransportServer.send', () => {
  const buffer = new Uint8Array([0x01])

  it('maps uWS (node runtime) statuses truthfully: sent(1)/buffered(0) succeed, dropped(2) fails', () => {
    const create = () =>
      NodeWsTransport.factory(options as any) as WsTransportServer
    expect(setPeer(create(), () => 1).send('c1', buffer)).toBe(true)
    expect(setPeer(create(), () => 0).send('c1', buffer)).toBe(true)
    expect(setPeer(create(), () => 2).send('c1', buffer)).toBe(false)
  })

  it('maps Bun statuses truthfully: bytes sent(>0)/backpressure(-1) succeed, dropped(0) fails', () => {
    // crossws refuses to create its Bun adapter unless a Bun global exists
    vi.stubGlobal('Bun', {})
    try {
      const create = () =>
        BunWsTransport.factory(options as any) as WsTransportServer
      expect(setPeer(create(), () => 2).send('c1', buffer)).toBe(true)
      expect(setPeer(create(), () => -1).send('c1', buffer)).toBe(true)
      expect(setPeer(create(), () => 0).send('c1', buffer)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats numeric statuses as success when the adapter has no interpreter', () => {
    const server = new WsTransportServer(adapterFactory, options)
    expect(setPeer(server, () => 0).send('c1', buffer)).toBe(true)
  })

  it('passes boolean results through', () => {
    const server = new WsTransportServer(adapterFactory, options)
    expect(setPeer(server, () => true).send('c1', buffer)).toBe(true)
    expect(setPeer(server, () => false).send('c1', buffer)).toBe(false)
  })

  it('returns false for unknown connections', () => {
    const server = new WsTransportServer(adapterFactory, options)
    expect(server.send('missing', buffer)).toBe(false)
  })

  it('returns false and drops the peer when send throws', () => {
    const server = setPeer(
      new WsTransportServer(adapterFactory, options),
      () => {
        throw new Error('boom')
      },
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(server.send('c1', buffer)).toBe(false)
    expect(server.clients.has('c1')).toBe(false)
    consoleError.mockRestore()
  })
})
