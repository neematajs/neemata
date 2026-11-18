import type { AddressInfo } from 'node:net'
import { Agent, createServer, get } from 'node:http'
import { connect } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { closeHttpServer } from '../../src/public/http.ts'

let agent: Agent | undefined
afterEach(() => agent?.destroy())

// One keep-alive agent, like the proxy's pooled upstream connections.
async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  agent = new Agent({ keepAlive: true })
  // `fresh` opens a connection of its own instead of reusing a pooled one.
  const request = (path: string, fresh = false) =>
    new Promise<string>((resolve) => {
      get({ port, path, agent: fresh ? false : agent }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(body))
        res.on('error', () => resolve('aborted'))
      }).on('error', (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? 'error'),
      )
    })
  return { server, request }
}

describe('closeHttpServer', () => {
  it('lets in-flight responses finish, then closes their kept-alive connections', async () => {
    const entered = Promise.withResolvers<void>()
    const { server, request } = await listen((req, res) => {
      if (req.url !== '/slow') return res.end('fast')
      entered.resolve()
      setTimeout(() => res.end('slow'), 200)
    })
    // Leaves one connection idle and one busy when the close begins.
    await request('/fast')
    const slow = request('/slow')
    await entered.promise

    const startedAt = Date.now()
    const closed = closeHttpServer(server)
    expect(await slow).toBe('slow')
    await closed
    // Plain server.close() would still wait on the slow request's socket.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(await request('/fast', true)).toBe('ECONNREFUSED')
  })

  it('force-closes requests still running once the signal aborts', async () => {
    const entered = Promise.withResolvers<void>()
    const { server, request } = await listen(() => {
      // Never responds.
      entered.resolve()
    })
    const hanging = request('/hang')
    await entered.promise

    const controller = new AbortController()
    const closed = closeHttpServer(server, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await closed
    expect(await hanging).toBe('ECONNRESET')
  })

  it('resolves once the signal aborts although an upgraded connection stays open', async () => {
    const { server } = await listen(() => {})
    // Upgraded sockets leave the HTTP server's tracking, so it cannot close
    // them, and `server.close()` never calls back while one is open.
    server.on('upgrade', (_request, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      )
    })
    const { port } = server.address() as AddressInfo
    const client = connect(port, '127.0.0.1')
    client.write(
      'GET / HTTP/1.1\r\nHost: neem\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
    await new Promise((resolve) => client.once('data', resolve))

    try {
      const controller = new AbortController()
      const closed = closeHttpServer(server, { signal: controller.signal })
      setTimeout(() => controller.abort(), 50)
      await closed
    } finally {
      client.destroy()
    }
  }, 2_000)

  it('resolves for a server that is not listening', async () => {
    await expect(closeHttpServer(createServer())).resolves.toBeUndefined()
  })
})
