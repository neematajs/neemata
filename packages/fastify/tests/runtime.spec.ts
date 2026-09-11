import { MessageChannel } from 'node:worker_threads'

import websocket from '@fastify/websocket'
import { CoreInjectables, createLogger } from '@nmtjs/core'
import { Proxy } from '@nmtjs/proxy'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { defineFastifyPlanner, defineFastifyWorker } from '../src/index.ts'

const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

describe('Fastify Neem runtime', () => {
  it('plans the requested number of workers', async () => {
    const planner = defineFastifyPlanner(async (ctx) => {
      expect(ctx).toMatchObject({ mode: 'development', name: 'api', logger })
      return { instances: 2 }
    })

    await expect(
      planner({ mode: 'development', name: 'api', logger }),
    ).resolves.toEqual({ workers: [undefined, undefined] })
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid instance count [%s]',
    async (instances) => {
      const planner = defineFastifyPlanner(() => ({ instances }))

      await expect(
        planner({ mode: 'development', name: 'api', logger }),
      ).rejects.toThrow('Fastify instances must be a positive integer')
    },
  )

  it('announces one listener for HTTP and WebSocket traffic', async () => {
    const listen = vi.fn(async () => 'http://127.0.0.1:3100')
    const close = vi.fn(async () => {
      throw new Error('close failed')
    })
    let disposeCalls = 0
    const worker = defineFastifyWorker((ctx) => {
      expect(ctx).toMatchObject({
        logger,
        mode: 'development',
        name: 'api:0',
      })
      expect(ctx.container.get(CoreInjectables.logger)).toBe(logger)
      const dispose = ctx.container.dispose.bind(ctx.container)
      ctx.container.dispose = async () => {
        disposeCalls++
        await dispose()
      }
      return { listen, close }
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'api:0',
      data: undefined,
      logger,
      definition: worker.definition,
      port: channel.port1,
    })

    try {
      await expect(runtime.start()).resolves.toEqual([
        { type: 'http', url: 'http://127.0.0.1:3100' },
        { type: 'ws', url: 'http://127.0.0.1:3100' },
      ])
      expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0 })
      await expect(runtime.stop()).rejects.toThrow('close failed')
      expect(disposeCalls).toBe(1)
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('proxies Fastify HTTP and WebSocket routes through Neem', async () => {
    const worker = defineFastifyWorker(async () => {
      const app = Fastify()
      await app.register(websocket)
      app.get('/health', async () => ({ ok: true }))
      app.get('/socket', { websocket: true }, (socket) => {
        socket.on('message', (message) => socket.send(message))
      })
      return app
    })
    const channel = new MessageChannel()
    const runtime = await worker.createRuntime({
      mode: 'development',
      name: 'api:0',
      data: undefined,
      logger,
      definition: worker.definition,
      port: channel.port1,
    })
    const proxy = new Proxy({
      listen: '127.0.0.1:0',
      applications: [{ name: 'api', routing: { type: 'default' } }],
      healthCheckIntervalMs: 25,
    })
    let socket: WebSocket | undefined

    try {
      const upstreams = await runtime.start()
      for (const upstream of upstreams ?? []) {
        const url = new URL(upstream.url)
        await proxy.addUpstream('api', {
          type: 'port',
          transport: upstream.type,
          secure: url.protocol === 'https:' || url.protocol === 'wss:',
          hostname: url.hostname,
          port: Number.parseInt(url.port, 10),
        })
      }
      await proxy.start()
      const address = proxy.address()
      expect(address).not.toBeNull()
      const origin = `http://${address!.hostname}:${address!.port}`

      const response = await waitForHttp(`${origin}/health`)
      await expect(response.json()).resolves.toEqual({ ok: true })

      socket = await waitForWebSocket(
        `ws://${address!.hostname}:${address!.port}/socket`,
      )
      const echoed = new Promise<string>((resolve) => {
        socket!.addEventListener(
          'message',
          async (event) => {
            resolve(
              event.data instanceof Blob
                ? await event.data.text()
                : String(event.data),
            )
          },
          { once: true },
        )
      })
      socket.send('hello')
      await expect(echoed).resolves.toBe('hello')

      const closed = new Promise<void>((resolve) => {
        socket!.addEventListener('close', () => resolve(), { once: true })
      })
      socket.close()
      await closed
      socket = undefined
    } finally {
      socket?.close()
      await proxy.stop()
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })
})

async function waitForHttp(url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await wait(25)
  }
  throw lastError
}

async function waitForWebSocket(url: string): Promise<WebSocket> {
  let lastError: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await openWebSocket(url)
    } catch (error) {
      lastError = error
      await wait(25)
    }
  }
  throw lastError
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const cleanup = () => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
    }
    const onError = () => {
      cleanup()
      reject(new Error('WebSocket upgrade failed'))
    }
    const onOpen = () => {
      cleanup()
      resolve(socket)
    }
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
