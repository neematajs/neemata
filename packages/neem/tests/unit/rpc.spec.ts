import { MessageChannel } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { NoParams } from '../../src/internal/rpc.ts'
import { RpcChannel, serveRpc } from '../../src/internal/rpc.ts'

type EchoCommands = {
  echo: { params: { value: string }; result: string }
  slow: { params: { value: string }; result: string }
}

describe('RpcChannel', () => {
  it('rejects and forgets a request whose post throws synchronously', async () => {
    const rpc = new RpcChannel<EchoCommands>({
      post: () => {
        throw new Error('port closed')
      },
      timeoutMs: () => 30_000,
      timeoutMessage: () => 'timed out',
    })

    await expect(rpc.request('echo', { value: 'a' })).rejects.toThrow(
      'port closed',
    )
    const pending = (rpc as unknown as { pending: Map<number, unknown> })
      .pending
    expect(pending.size).toBe(0)
    // A late reply for the failed id settles nothing.
    expect(rpc.settle({ id: 1, type: 'result', data: 'late' })).toBe(false)
  })

  it('ignores messages that are not replies to a pending request', async () => {
    const rpc = new RpcChannel<EchoCommands>({
      post: () => {},
      timeoutMs: () => 30_000,
      timeoutMessage: () => 'timed out',
    })
    const request = rpc.request('echo', { value: 'a' })

    expect(rpc.settle({ id: 1, type: 'event', event: {} })).toBe(false)
    expect(rpc.settle({ id: 1, type: 'ready' })).toBe(false)
    expect(rpc.settle({ id: '1', type: 'result' })).toBe(false)
    expect(rpc.settle(null)).toBe(false)
    expect(rpc.settle({ id: 1, type: 'result', data: 'a' })).toBe(true)
    await expect(request).resolves.toBe('a')
  })
})

describe('serveRpc', () => {
  it('replies with an error to a command the server does not serve', async () => {
    const { client } = createPair({
      echo: ({ value }) => value,
      slow: ({ value }) => value,
    })
    const unknown = client as unknown as RpcChannel<{
      missing: { params: NoParams; result: void }
    }>

    await expect(unknown.request('missing', {})).rejects.toThrow(
      'Test server received unknown command [missing]',
    )
    await expect(
      client.request('echo', { value: 'still served' }),
    ).resolves.toBe('still served')
  })

  it('replies with the handler error', async () => {
    const { client } = createPair({
      echo: () => {
        throw new Error('handler failed')
      },
      slow: ({ value }) => value,
    })

    await expect(client.request('echo', { value: 'a' })).rejects.toThrow(
      'handler failed',
    )
  })

  it('runs serial commands one at a time and others on arrival', async () => {
    const release = createFuture<void>()
    const order: string[] = []
    const { client } = createPair(
      {
        echo: ({ value }) => {
          order.push(`echo:${value}`)
          return value
        },
        slow: async ({ value }) => {
          order.push(`slow:${value}:start`)
          if (value === 'first') await release.promise
          order.push(`slow:${value}:end`)
          return value
        },
      },
      ['slow'],
    )

    const first = client.request('slow', { value: 'first' })
    const second = client.request('slow', { value: 'second' })
    await expect(client.request('echo', { value: 'free' })).resolves.toBe(
      'free',
    )
    release.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ])
    expect(order).toEqual([
      'slow:first:start',
      'echo:free',
      'slow:first:end',
      'slow:second:start',
      'slow:second:end',
    ])
  })
})

function createPair(
  handlers: Parameters<typeof serveRpc<EchoCommands, never>>[2],
  serial: readonly (keyof EchoCommands)[] = [],
) {
  const { port1, port2 } = new MessageChannel()
  onTestFinished(() => {
    port1.close()
    port2.close()
  })
  serveRpc<EchoCommands, never>(port2, 'Test server', handlers, { serial })
  const client = new RpcChannel<EchoCommands>({
    post: (message) => port1.postMessage(message),
    timeoutMs: () => 5_000,
    timeoutMessage: (type) => `request [${type}] timed out`,
  })
  port1.on('message', (message: unknown) => client.settle(message))
  return { client }
}
