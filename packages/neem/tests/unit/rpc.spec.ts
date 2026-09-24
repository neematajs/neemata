import { MessageChannel } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type { NoParams, RpcServerOptions } from '../../src/internal/rpc.ts'
import {
  DEFAULT_EXIT_HOOK_TIMEOUT_MS,
  RpcChannel,
  serveRpc,
} from '../../src/internal/rpc.ts'

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

  it('exits after the reply only once the beforeExit hook settles, passing it the budget', async () => {
    const exit = stubProcessExit()
    const flushed = createFuture<void>()
    const beforeExit = vi.fn(() => flushed.promise)
    const { client } = createPair(
      {
        echo: ({ value }, { exitAfterReply }) => {
          exitAfterReply(0, 1_234)
          return value
        },
        slow: ({ value }) => value,
      },
      [],
      { beforeExit },
    )

    await expect(client.request('echo', { value: 'bye' })).resolves.toBe('bye')
    await vi.waitFor(() => expect(beforeExit).toHaveBeenCalledWith(1_234))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exit).not.toHaveBeenCalled()

    flushed.resolve()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it('gives a fatal exit the default hook budget and exits even if the hook fails', async () => {
    const exit = stubProcessExit()
    const beforeExit = vi.fn(async () => {
      throw new Error('flush failed')
    })
    const { server } = createPair(
      { echo: ({ value }) => value, slow: ({ value }) => value },
      [],
      { beforeExit },
    )

    await server.exit(1)
    expect(beforeExit).toHaveBeenCalledWith(DEFAULT_EXIT_HOOK_TIMEOUT_MS)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})

function stubProcessExit() {
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as typeof process.exit)
  onTestFinished(() => exit.mockRestore())
  return exit
}

function createPair(
  handlers: Parameters<typeof serveRpc<EchoCommands, never>>[2],
  serial: readonly (keyof EchoCommands)[] = [],
  options: RpcServerOptions<EchoCommands> = {},
) {
  const { port1, port2 } = new MessageChannel()
  onTestFinished(() => {
    port1.close()
    port2.close()
  })
  const server = serveRpc<EchoCommands, never>(port2, 'Test server', handlers, {
    ...options,
    serial,
  })
  const client = new RpcChannel<EchoCommands>({
    post: (message) => port1.postMessage(message),
    timeoutMs: () => 5_000,
    timeoutMessage: (type) => `request [${type}] timed out`,
  })
  port1.on('message', (message: unknown) => client.settle(message))
  return { client, server }
}
