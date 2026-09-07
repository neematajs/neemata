import type { ServerHost } from '@nmtjs/transports/http-server'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NeemataWebSocketHandler,
  WS_PENDING_OPEN_TTL,
} from '../../../src/neemata/ws/server.ts'

const createTestCodecs = () => new ProtocolCodecRegistry([new JsonCodec()])

const createHandler = () => {
  const onConnect = vi.fn(async (_options: any) => ({ id: 'conn-1' }))
  const onDisconnect = vi.fn(async () => {})
  const handler = new NeemataWebSocketHandler(
    { onConnect, onDisconnect } as any,
    { isSendSuccess: () => true } as unknown as ServerHost,
    createTestCodecs(),
    { path: '/', heartbeat: false },
  )
  return { handler, hooks: handler.hooks, onConnect, onDisconnect }
}

const upgradeRequest = {
  url: 'http://localhost/',
  headers: new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
  }),
  method: 'GET',
} as any

describe('NeemataWebSocketHandler pending-open TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reaps a connection whose open hook never fires', async () => {
    const { hooks, onConnect, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onConnect.mock.calls[0]![0].data).toBeInstanceOf(Request)
    expect(onDisconnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL)

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledWith('conn-1')
  })

  it('does not reap a connection once open fires', async () => {
    const { hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    await hooks.open!({
      context: { connectionId: 'conn-1' },
      send: vi.fn(),
    } as any)

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it('clears the reap timer when a pending-open connection is terminated', async () => {
    const { handler, hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    // Session-initiated termination (e.g. heartbeat timeout) before `open`
    // fires: the registry claims the entry and delivers the one disconnect
    await handler.connections.disconnect('conn-1', {
      code: 1001,
      reason: 'heartbeat_timeout',
    })
    expect(onDisconnect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    // the claimed reap timer must not deliver a late disconnect either
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('closes a peer whose open arrives after the reap', async () => {
    const { handler, hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL)
    expect(onDisconnect).toHaveBeenCalledTimes(1)

    const peer = {
      context: { connectionId: 'conn-1' },
      close: vi.fn(),
      send: vi.fn(),
    } as any
    await hooks.open!(peer)

    expect(peer.close).toHaveBeenCalledWith(1001, 'Closed')
    expect(handler.connections.peer('conn-1')).toBeUndefined()
  })

  it('cancels the reap timer when close fires before open', async () => {
    const { hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    await hooks.close!({ context: { connectionId: 'conn-1' } } as any, {})

    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    // Only the close hook itself disconnects; the timer must not fire again
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects a pending-open connection during disposal', async () => {
    const { handler, hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)

    await handler.dispose()
    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)

    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onDisconnect).toHaveBeenCalledWith('conn-1')
  })

  it('disconnects an open peer exactly once during disposal', async () => {
    const { handler, hooks, onDisconnect } = createHandler()
    await hooks.upgrade!(upgradeRequest)
    const peer = {
      context: { connectionId: 'conn-1' },
      close: vi.fn(),
      send: vi.fn(),
    } as any
    await hooks.open!(peer)

    await handler.dispose()
    // the runtime still fires the close hook for the peer dispose() closed;
    // the registry already claimed the connection, so it must be a no-op
    await hooks.close!(peer, {})

    expect(peer.close).toHaveBeenCalledWith(1001, 'Handler stopped')
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onDisconnect).toHaveBeenCalledWith('conn-1')
  })

  it('waits for and disconnects an upgrade in flight during disposal', async () => {
    let resolveConnect!: (connection: { id: string }) => void
    const connection = new Promise<{ id: string }>((resolve) => {
      resolveConnect = resolve
    })
    const onConnect = vi.fn(() => connection)
    const onDisconnect = vi.fn(async () => {})
    const handler = new NeemataWebSocketHandler(
      { onConnect, onDisconnect } as any,
      { isSendSuccess: () => true } as unknown as ServerHost,
      createTestCodecs(),
      { path: '/', heartbeat: false },
    )

    const upgrading = handler.hooks.upgrade!(upgradeRequest)
    await Promise.resolve()
    const disposing = handler.dispose()
    let disposed = false
    void disposing.then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    resolveConnect({ id: 'conn-1' })
    const response = await upgrading
    await disposing

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(500)
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onDisconnect).toHaveBeenCalledWith('conn-1')
    // nothing was admitted: no reap timer left behind to double-fire
    expect(handler.connections.peer('conn-1')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(WS_PENDING_OPEN_TTL * 2)
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
