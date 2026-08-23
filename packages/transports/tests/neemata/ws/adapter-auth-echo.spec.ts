import type { ServerHost } from '@nmtjs/transports/http-server'
import { encodeWsAuthSubprotocol } from '@nmtjs/protocol'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'
import createBunAdapter from 'crossws/adapters/bun'
import createDenoAdapter from 'crossws/adapters/deno'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NeemataWebSocketHandler } from '../../../src/neemata/ws/server.ts'

const createHandler = () => {
  const onConnect = vi.fn(async (_options: any) => ({ id: 'c1' }))
  const handler = new NeemataWebSocketHandler(
    { onConnect, onDisconnect: vi.fn(async () => {}) } as any,
    { isSendSuccess: () => true } as unknown as ServerHost,
    new ProtocolCodecRegistry([new JsonCodec()]),
    { path: '/', heartbeat: false },
  )
  return { handler, onConnect }
}

const authRequest = (subprotocol: string) =>
  new Request(
    'http://localhost/ws?accept=application/json&content-type=application/json',
    { headers: { 'sec-websocket-protocol': subprotocol } },
  )

const originalBun = Object.getOwnPropertyDescriptor(globalThis, 'Bun')
const originalDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno')

afterEach(() => {
  if (!originalBun) Reflect.deleteProperty(globalThis, 'Bun')
  if (originalDeno) Object.defineProperty(globalThis, 'Deno', originalDeno)
  else Reflect.deleteProperty(globalThis, 'Deno')
})

describe('auth echo through Request-based runtime adapters', () => {
  it('passes the exact selection to Bun server.upgrade', async () => {
    if (!originalBun) {
      Object.defineProperty(globalThis, 'Bun', {
        configurable: true,
        value: {},
      })
    }
    const { handler, onConnect } = createHandler()
    const adapter = createBunAdapter({ hooks: handler.hooks })
    const upgrade = vi.fn((_request: Request, _options: any) => true)
    const subprotocol = encodeWsAuthSubprotocol('Bearer bun')

    await adapter.handleUpgrade(authRequest(subprotocol), { upgrade } as any)

    const options = upgrade.mock.calls[0]![1]
    expect(new Headers(options.headers).get('sec-websocket-protocol')).toBe(
      subprotocol,
    )
    expect(
      (onConnect.mock.calls[0]![0].data as Request).headers.get(
        'authorization',
      ),
    ).toBe('Bearer bun')
    await handler.dispose()
  })

  it('passes the exact selection as Deno protocol and response header', async () => {
    const addEventListener = vi.fn()
    const upgradeWebSocket = vi.fn((_request: Request, _options: any) => ({
      response: new Response(),
      socket: { addEventListener },
    }))
    Object.defineProperty(globalThis, 'Deno', {
      configurable: true,
      value: { upgradeWebSocket },
    })
    const { handler, onConnect } = createHandler()
    const adapter = createDenoAdapter({ hooks: handler.hooks })
    const subprotocol = encodeWsAuthSubprotocol('Bearer deno')

    await adapter.handleUpgrade(authRequest(subprotocol), {} as any)

    const options = upgradeWebSocket.mock.calls[0]![1]
    expect(options.protocol).toBe(subprotocol)
    expect(options.headers.get('sec-websocket-protocol')).toBe(subprotocol)
    expect(
      (onConnect.mock.calls[0]![0].data as Request).headers.get(
        'authorization',
      ),
    ).toBe('Bearer deno')
    await handler.dispose()
  })
})
