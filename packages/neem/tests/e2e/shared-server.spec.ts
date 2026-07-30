import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  getDistinctFreePorts,
  readRuntimeEvents,
  spawnNeem,
  waitFor,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem proxy with a shared transport server', () => {
  it('routes HTTP and WS traffic to one upstream registered under both types', async () => {
    const fixture = await createNeemFixture({ config: 'shared-server' })
    fixtures.push(fixture)
    const [proxyPort] = await getDistinctFreePorts(1)

    const neem = spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_PROXY_PORT: String(proxyPort),
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )
    spawned.push(neem)

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    // the gateway reported one bound URL under both proxyable types
    const hostsEvent = await waitFor(async () => {
      const events = await readRuntimeEvents(fixture.eventsFile)
      return events.find((event) => event.event === 'shared-server-hosts')
    }, 30_000)
    const hosts = hostsEvent.hosts as Array<{ type: string; url: string }>
    expect(hosts).toHaveLength(2)
    expect(new Set(hosts.map((host) => host.url)).size).toBe(1)
    expect(hosts.map((host) => host.type).sort()).toEqual(['http', 'ws'])

    const details = () =>
      [neem.stdout(), neem.stderr()].filter(Boolean).join('\n')

    // HTTP RPC round-trips through the real native proxy
    const echoed = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ping: 1 }),
        })
        if (response.status !== 200) return false
        return (await response.json()) as Record<string, unknown>
      },
      30_000,
      details,
    )
    expect(echoed).toMatchObject({ procedure: 'echo', payload: { ping: 1 } })

    // the host-owned health route flows through the same proxied address
    const healthy = await fetch(`http://127.0.0.1:${proxyPort}/healthy`)
    expect(healthy.status).toBe(200)

    // a WS upgrade through the same proxy port reaches the ws transport:
    // open fires only after the gateway accepted the connection (format
    // negotiation via query params), proving upgrade headers and query
    // traversed the proxy onto the shared socket
    const socket = await waitFor(
      () =>
        new Promise<WebSocket | false>((resolve) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${proxyPort}/?accept=application/json&content-type=application/json`,
          )
          ws.onopen = () => resolve(ws)
          ws.onerror = () => resolve(false)
        }),
      30_000,
      details,
    )
    socket.close()

    await neem.stop()
  }, 60_000)
})
