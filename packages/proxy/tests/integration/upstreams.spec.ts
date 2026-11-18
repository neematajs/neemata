import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { Proxy as NeemataProxy } from '../../dist/index.js'
import {
  expectRejectCode,
  getFreePort,
  httpGet,
  httpRequest,
  listenOnEphemeralPort,
  waitFor,
} from '../_helpers.ts'

type Upstream = {
  name: string
  port: number
  requests: number
  /** TCP connections, including health probes that send no request. */
  connections: number
  stop(): Promise<void>
  /** Listens again on the same port. */
  restart(): Promise<void>
  upstream(transport?: 'http' | 'ws'): {
    type: 'port'
    transport: 'http' | 'ws'
    secure: false
    hostname: string
    port: number
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

/** Answers `<name>` to GET and `<name>:<body>` to requests with a body. */
async function startUpstream(name: string, port?: number): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    state.requests++
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      res.end(body ? `${name}:${body}` : name)
    })
  })
  server.on('connection', () => {
    state.connections++
  })

  const listen = async (p: number) =>
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

  const state: Upstream = {
    name,
    port: 0,
    requests: 0,
    connections: 0,
    async stop() {
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    async restart() {
      await listen(state.port)
    },
    upstream(transport = 'http') {
      return {
        type: 'port',
        transport,
        secure: false,
        hostname: '127.0.0.1',
        port: state.port,
      }
    },
  }

  if (port === undefined) {
    state.port = await listenOnEphemeralPort(server)
  } else {
    state.port = port
    await listen(port)
  }
  cleanups.push(() => state.stop())
  return state
}

/** An upstream nothing listens on, so connects to it are refused. */
async function deadUpstream() {
  return {
    type: 'port',
    transport: 'http',
    secure: false,
    hostname: '127.0.0.1',
    port: await getFreePort(),
  } as const
}

/**
 * An upstream whose connects hang until they time out: its listener is never accepted from,
 * and once its accept queue is full the kernel drops further connection attempts.
 */
async function blackholedUpstream() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:net').createServer()
       s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => console.log(s.address().port))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const fillers: net.Socket[] = []
  cleanups.push(async () => {
    for (const socket of fillers) socket.destroy()
    child.kill('SIGKILL')
  })
  const [chunk] = await once(child.stdout!, 'data')
  const port = Number(String(chunk).trim())
  child.kill('SIGSTOP')

  for (let i = 0; i < 64; i++) {
    const socket = net.connect(port, '127.0.0.1')
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 200)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!connected) {
      socket.destroy()
      return {
        type: 'port',
        transport: 'http',
        secure: false,
        hostname: '127.0.0.1',
        port,
      } as const
    }
    fillers.push(socket)
  }
  throw new Error('the accept queue never filled up')
}

async function startProxy(
  options: Partial<ConstructorParameters<typeof NeemataProxy>[0]> = {},
) {
  const proxy = new NeemataProxy({
    listen: '127.0.0.1:0',
    applications: [{ name: 'app', routing: { type: 'default' } }],
    ...options,
  })
  cleanups.push(() => proxy.stop())
  return proxy
}

const noUpstream = (r: { status: number }) => r.status === 503

describe('upstream health across membership changes', () => {
  // Interval too long to fire during a test: only `start()` and additions to a pool probe.
  const healthCheckIntervalMs = 60_000

  // The upstream is marked down while dead, then listens again; it must stay down until
  // probed, so a membership change that reset its health would let requests reach it.
  async function upstreamMarkedDownButListening(
    proxy: NeemataProxy,
    extra: Array<Parameters<NeemataProxy['addUpstream']>[1]> = [],
  ) {
    const revived = await startUpstream('revived')
    await revived.stop()
    for (const u of [revived.upstream(), ...extra]) {
      await proxy.addUpstream('app', u)
    }
    await proxy.start()
    const port = proxy.address()!.port
    await waitFor(async () => await httpGet(port, '/'), noUpstream)
    await revived.restart()
    return { revived, port }
  }

  it('keeps a down upstream down when another is removed', async () => {
    const proxy = await startProxy({ healthCheckIntervalMs })
    const other = await deadUpstream()
    const { revived, port } = await upstreamMarkedDownButListening(proxy, [
      other,
    ])

    await proxy.removeUpstream('app', other)

    expect((await httpGet(port, '/')).status).toBe(503)
    expect(revived.requests).toBe(0)
  })

  it('keeps a down upstream down when the app gains another pool', async () => {
    const proxy = await startProxy({ healthCheckIntervalMs })
    const { revived, port } = await upstreamMarkedDownButListening(proxy)
    const ws = await startUpstream('ws')

    await proxy.addUpstream('app', ws.upstream('ws'))

    expect((await httpGet(port, '/')).status).toBe(503)
    expect(revived.requests).toBe(0)
  })

  it('keeps a down upstream down when setUpstreams retains it', async () => {
    const proxy = await startProxy({ healthCheckIntervalMs })
    const other = await deadUpstream()
    const { revived, port } = await upstreamMarkedDownButListening(proxy, [
      other,
    ])

    await proxy.setUpstreams([
      { application: 'app', upstream: revived.upstream() },
    ])

    expect((await httpGet(port, '/')).status).toBe(503)
    expect(revived.requests).toBe(0)
  })

  it('probes upstreams added to a running pool right away', async () => {
    const proxy = await startProxy({ healthCheckIntervalMs })
    const alive = await startUpstream('alive')
    await proxy.addUpstream('app', alive.upstream())
    await proxy.start()
    const port = proxy.address()!.port

    await proxy.addUpstream('app', await deadUpstream())
    await proxy.removeUpstream('app', alive.upstream())

    // A refused connect answers 502 until the probe marks the dead upstream down.
    await waitFor(async () => await httpGet(port, '/'), noUpstream)
  })
})

describe('setUpstreams', () => {
  const applications = [
    { name: 'a', routing: { type: 'path', name: 'a' } },
    { name: 'b', routing: { type: 'path', name: 'b' } },
  ] as const

  async function bodies(port: number, path: string, count: number) {
    const seen = new Set<string>()
    for (let i = 0; i < count; i++) {
      const res = await httpGet(port, path)
      seen.add(`${res.status}:${res.body}`)
    }
    return [...seen].sort()
  }

  it('replaces the upstreams of every application in one call', async () => {
    const [a1, a2, b1] = await Promise.all([
      startUpstream('a1'),
      startUpstream('a2'),
      startUpstream('b1'),
    ])
    const proxy = await startProxy({ applications: [...applications] })
    await proxy.start()
    const port = proxy.address()!.port

    await proxy.setUpstreams([
      { application: 'a', upstream: a1.upstream() },
      { application: 'a', upstream: a2.upstream() },
      { application: 'b', upstream: b1.upstream() },
    ])
    expect(await bodies(port, '/a', 4)).toEqual(['200:a1', '200:a2'])
    expect(await bodies(port, '/b', 2)).toEqual(['200:b1'])

    // Unlisted applications are left without upstreams.
    await proxy.setUpstreams([{ application: 'a', upstream: a2.upstream() }])
    expect(await bodies(port, '/a', 4)).toEqual(['200:a2'])
    expect((await httpGet(port, '/b')).status).toBe(503)

    // The single-upstream API works on the same membership.
    await proxy.addUpstream('b', b1.upstream())
    await proxy.removeUpstream('a', a2.upstream())
    expect((await httpGet(port, '/a')).status).toBe(503)
    expect(await bodies(port, '/b', 2)).toEqual(['200:b1'])

    await proxy.setUpstreams([])
    expect((await httpGet(port, '/a')).status).toBe(503)
    expect((await httpGet(port, '/b')).status).toBe(503)
  })

  it('applies nothing when any entry is invalid', async () => {
    const [a1, a2, b1] = await Promise.all([
      startUpstream('a1'),
      startUpstream('a2'),
      startUpstream('b1'),
    ])
    const proxy = await startProxy({ applications: [...applications] })
    await proxy.setUpstreams([{ application: 'a', upstream: a1.upstream() }])
    await proxy.start()
    const port = proxy.address()!.port

    // Every batch below would also replace a1 with a2 and add b1.
    const valid = [
      { application: 'a', upstream: a2.upstream() },
      { application: 'b', upstream: b1.upstream() },
    ]

    await expectRejectCode(
      () =>
        proxy.setUpstreams([
          ...valid,
          { application: 'missing', upstream: a1.upstream() },
        ]),
      'UnknownApplication',
    )
    await expectRejectCode(
      () =>
        proxy.setUpstreams([
          ...valid,
          { application: 'b', upstream: b1.upstream() },
        ]),
      'UpstreamAlreadyExists',
    )
    await expectRejectCode(
      () =>
        proxy.setUpstreams([
          ...valid,
          { application: 'a', upstream: { ...a1.upstream(), port: 0 } },
        ]),
      'InvalidProxyOptions',
    )
    await expectRejectCode(
      () =>
        proxy.setUpstreams([
          ...valid,
          { application: 'a', upstream: { ...a1.upstream(), secure: true } },
        ]),
      'InvalidProxyOptions',
      'Mixing secure and insecure upstreams',
    )

    expect(await bodies(port, '/a', 4)).toEqual(['200:a1'])
    expect((await httpGet(port, '/b')).status).toBe(503)
  })
})

describe('sticky sessions and upstream health', () => {
  it('moves a sticky client off an upstream marked down', async () => {
    // Probes run in port order, so the highest-port upstream, added last, is
    // the sentinel: once its probe connects, the others have been probed.
    const [first, second, last] = (
      await Promise.all([
        startUpstream('first'),
        startUpstream('second'),
        startUpstream('last'),
      ])
    ).sort((a, b) => a.port - b.port)
    const proxy = await startProxy({
      stickySessions: { enabled: true },
      healthCheckIntervalMs: 60_000,
    })
    await proxy.addUpstream('app', first.upstream())
    await proxy.addUpstream('app', second.upstream())
    await proxy.start()
    const port = proxy.address()!.port
    const sticky = async () =>
      await httpGet(port, '/', { 'x-nmt-affinity-key': 'client' })

    const mappedName = (await sticky()).body
    const [mapped, other] =
      mappedName === first.name ? [first, second] : [second, first]

    await mapped.stop()
    await proxy.addUpstream('app', last.upstream())
    await waitFor(
      async () => last.connections,
      (n) => n > 0,
    )
    // Listening again, but marked down until the next probe a minute away.
    await mapped.restart()
    const requestsBefore = mapped.requests

    const moved = await sticky()
    expect(moved.status).toBe(200)
    expect([other.name, last.name]).toContain(moved.body)
    expect(mapped.requests).toBe(requestsBefore)

    // The new mapping sticks.
    expect((await sticky()).body).toBe(moved.body)
  })
})

describe('retry after a refused connect', () => {
  it('serves requests to an upstream that refuses connections from another', async () => {
    const [alive, dying] = await Promise.all([
      startUpstream('alive'),
      startUpstream('dying'),
    ])
    // Probed healthy at start, then no probe notices it dying.
    const proxy = await startProxy({ healthCheckIntervalMs: 60_000 })
    await proxy.addUpstream('app', alive.upstream())
    await proxy.addUpstream('app', dying.upstream())
    await proxy.start()
    const port = proxy.address()!.port
    expect((await httpGet(port, '/')).status).toBe(200)

    await dying.stop()

    // Round robin selects the dead upstream for every other request.
    for (let i = 0; i < 4; i++) {
      const get = await httpGet(port, '/')
      expect(get).toMatchObject({ status: 200, body: 'alive' })

      const post = await httpRequest(port, {
        method: 'POST',
        path: '/',
        headers: { 'content-type': 'text/plain' },
        body: `payload-${i}`,
      })
      expect(post).toMatchObject({ status: 200, body: `alive:payload-${i}` })
    }

    // With no other upstream left, the refused connect is still a 502.
    await proxy.removeUpstream('app', alive.upstream())
    const res = await httpRequest(port, {
      method: 'POST',
      path: '/',
      body: 'x',
    })
    expect(res.status).toBe(502)
    expect(res.body).toBe('Upstream request failed\n')
  })

  it('retries on the pool that replaced the one the first connect used', async () => {
    const replacement = await startUpstream('replacement')
    const proxy = await startProxy({
      healthCheckIntervalMs: 60_000,
      // Long enough to replace the pool while the first connect is still pending.
      timeouts: { upstreamConnect: 3000 },
    })
    await proxy.addUpstream('app', await blackholedUpstream())
    await proxy.start()

    const pending = httpGet(proxy.address()!.port, '/')
    // Lets the request resolve its pool and start connecting, well within the connect timeout.
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Removing the last upstream drops the pool, so the next one gets a new pool.
    await proxy.setUpstreams([])
    await proxy.setUpstreams([
      { application: 'app', upstream: replacement.upstream() },
    ])

    expect(await pending).toMatchObject({ status: 200, body: 'replacement' })
  })

  it('retries on an HTTP/2 pool that replaced the HTTP/1 pool the first connect used', async () => {
    const h2 = http2.createServer()
    h2.on('stream', (stream) => {
      stream.respond({ ':status': 200 })
      stream.end('h2 replacement')
    })
    const h2Port = await listenOnEphemeralPort(h2)
    cleanups.push(() => new Promise((resolve) => h2.close(() => resolve())))

    const proxy = await startProxy({
      healthCheckIntervalMs: 60_000,
      timeouts: { upstreamConnect: 3000 },
    })
    await proxy.addUpstream('app', await blackholedUpstream())
    await proxy.start()

    const pending = httpGet(proxy.address()!.port, '/')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // One call: the HTTP/1 pool goes and an HTTP/2 pool takes its place.
    await proxy.setUpstreams([
      {
        application: 'app',
        upstream: {
          type: 'port',
          transport: 'http2',
          secure: false,
          hostname: '127.0.0.1',
          port: h2Port,
        },
      },
    ])

    expect(await pending).toMatchObject({ status: 200, body: 'h2 replacement' })
  })
})
