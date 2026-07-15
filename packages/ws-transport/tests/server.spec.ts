import type { Peer } from 'crossws'
import { describe, expect, it, vi } from 'vitest'

import type {
  WsAdapterServerFactory,
  WsTransportOptions,
} from '../src/types.ts'
import { WsTransportServer } from '../src/server.ts'

const adapterFactory: WsAdapterServerFactory<any> = () => ({
  start: vi.fn(async () => 'ws://localhost'),
  stop: vi.fn(async () => {}),
})

const options = { listen: { port: 0 } } as WsTransportOptions

const withPeer = (send: () => unknown) => {
  const server = new WsTransportServer(adapterFactory, options)
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

  it('maps uWS send codes truthfully: sent(1)/buffered(0) succeed, dropped(2) fails', () => {
    expect(withPeer(() => 1).send('c1', buffer)).toBe(true)
    expect(withPeer(() => 0).send('c1', buffer)).toBe(true)
    expect(withPeer(() => 2).send('c1', buffer)).toBe(false)
  })

  it('passes boolean results through', () => {
    expect(withPeer(() => true).send('c1', buffer)).toBe(true)
    expect(withPeer(() => false).send('c1', buffer)).toBe(false)
  })

  it('returns false for unknown connections', () => {
    const server = new WsTransportServer(adapterFactory, options)
    expect(server.send('missing', buffer)).toBe(false)
  })

  it('returns false and drops the peer when send throws', () => {
    const server = withPeer(() => {
      throw new Error('boom')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(server.send('c1', buffer)).toBe(false)
    expect(server.clients.has('c1')).toBe(false)
    consoleError.mockRestore()
  })
})
