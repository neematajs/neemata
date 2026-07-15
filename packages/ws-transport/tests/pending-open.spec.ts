import type { Hooks } from 'crossws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WS_PENDING_OPEN_TTL, WsTransportServer } from '../src/server.ts'

const createServer = () => {
  let hooks: Hooks
  const adapterFactory = vi.fn((params: any) => {
    hooks = params.wsHooks
    return {
      start: vi.fn(async () => 'ws://test'),
      stop: vi.fn(async () => {}),
    }
  })

  const server = new WsTransportServer(adapterFactory, {
    listen: { port: 0 },
  })

  return { server, getHooks: () => hooks! }
}

const upgradeRequest = {
  url: 'http://localhost/',
  headers: new Headers(),
  method: 'GET',
} as any

describe('WsTransportServer pending-open TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reaps a connection whose open hook never fires', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async () => ({ id: 'conn-1' }))
    const onDisconnect = vi.fn(async () => {})

    await server.start({ onConnect, onDisconnect } as any)
    await getHooks().upgrade!(upgradeRequest)

    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL)

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledWith('conn-1')
  })

  it('does not reap a connection once open fires', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async () => ({ id: 'conn-1' }))
    const onDisconnect = vi.fn(async () => {})

    await server.start({ onConnect, onDisconnect } as any)
    await getHooks().upgrade!(upgradeRequest)

    getHooks().open!({
      context: { connectionId: 'conn-1' },
      send: vi.fn(),
    } as any)

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it('cancels the reap timer when close fires before open', async () => {
    const { server, getHooks } = createServer()
    const onConnect = vi.fn(async () => ({ id: 'conn-1' }))
    const onDisconnect = vi.fn(async () => {})

    await server.start({ onConnect, onDisconnect } as any)
    await getHooks().upgrade!(upgradeRequest)

    await getHooks().close!({ context: { connectionId: 'conn-1' } } as any, {})

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    // Only the close hook itself disconnects; the timer must not fire again
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })
})
