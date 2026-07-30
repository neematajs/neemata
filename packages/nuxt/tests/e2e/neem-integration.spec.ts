import { access, cp, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SpawnedProcess } from './support/support.ts'
import { getFreePort, spawnWithCapture, waitFor } from './support/support.ts'

const neemBin = resolve(import.meta.dirname, '../../../neem/bin/neem.js')
const processes: SpawnedProcess[] = []
let fixtureDir = ''
let origin = ''
let env: NodeJS.ProcessEnv = {}
let buildResult:
  | {
      code: number | null
      signal: string | null
      stdout: string
      stderr: string
    }
  | undefined

beforeAll(async () => {
  const port = await getFreePort()
  origin = `http://127.0.0.1:${port}`
  // The fixture's neem.config.ts reads the port from this env var, so the
  // checked-in files stay literal while parallel runs never collide.
  env = { NEEM_TEST_PORT: String(port) }
  // Copied inside the package (not os tmpdir) so nuxt stays resolvable by
  // walking up to packages/nuxt/node_modules.
  fixtureDir = await mkdtemp(
    resolve(import.meta.dirname, '../.tmp-integration-'),
  )
  await cp(
    resolve(import.meta.dirname, '../fixtures/integration-app'),
    fixtureDir,
    {
      recursive: true,
    },
  )

  const build = spawnWithCapture([neemBin, 'build'], fixtureDir, env)
  const exit = await build.waitForExit()
  buildResult = {
    ...exit,
    stdout: build.stdout(),
    stderr: build.stderr(),
  }
}, 180_000)

afterEach(async () => {
  for (const process of processes.splice(0).reverse()) await process.stop()
})

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

describe('Nuxt runtime through Neem CLI and proxy', () => {
  it('builds both Nitro applications into their runtime artifacts', async () => {
    if (!buildResult) throw new Error('Neem build hook did not run')
    expect(
      buildResult.code,
      `stdout:\n${buildResult.stdout}\nstderr:\n${buildResult.stderr}`,
    ).toBe(0)
    await expect(
      access(
        resolve(fixtureDir, 'dist/runtime/web/worker/app/server/index.mjs'),
      ),
    ).resolves.toBeUndefined()
    await expect(
      access(
        resolve(fixtureDir, 'dist/runtime/admin/worker/app/server/index.mjs'),
      ),
    ).resolves.toBeUndefined()
    await expect(
      access(
        resolve(
          fixtureDir,
          'dist/runtime/web/worker/app/public/about/index.html',
        ),
      ),
    ).resolves.toBeUndefined()
  })

  it('serves SSR, prerendered, API, and immutable assets through neem start', async () => {
    const neem = spawnWithCapture([neemBin, 'start'], fixtureDir, env)
    processes.push(neem)
    const html = await waitFor(
      async () => {
        const response = await fetch(origin)
        const body = await response.text()
        return response.status === 200 && body.includes('neem-web-marker')
          ? body
          : false
      },
      60_000,
      () => `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`,
    )

    expect(html).toContain('hello-from-neem-api')
    await expect((await fetch(`${origin}/api/hello`)).json()).resolves.toEqual({
      message: 'hello-from-neem-api',
    })
    expect(
      (await fetch(`${origin}/api/hello`, { method: 'POST' })).status,
    ).toBe(404)
    expect(await (await fetch(`${origin}/about`)).text()).toContain(
      'neem-about-marker',
    )
    expect((await fetch(`${origin}/about/_payload.json`)).status).toBe(200)

    const webAsset = html.match(
      /(?:src|href)="([^"]*\/_nuxt\/[^"]+\.js[^"]*)"/,
    )?.[1]
    if (!webAsset)
      throw new Error('SSR HTML referenced no web JavaScript asset')
    const webAssetResponse = await fetch(new URL(webAsset, origin))
    expect(webAssetResponse.status).toBe(200)
    expect(webAssetResponse.headers.get('cache-control')).toContain('immutable')

    const adminHtml = await (await fetch(`${origin}/admin/`)).text()
    expect(adminHtml).toContain('neem-admin-marker')
    const adminAsset = adminHtml.match(
      /(?:src|href)="([^"]*\/admin\/_nuxt\/[^"]+\.js[^"]*)"/,
    )?.[1]
    if (!adminAsset) {
      throw new Error('Admin HTML referenced no base-prefixed JavaScript asset')
    }
    const adminAssetResponse = await fetch(new URL(adminAsset, origin))
    expect(adminAssetResponse.status).toBe(200)
    expect(adminAssetResponse.headers.get('cache-control')).toContain(
      'immutable',
    )
  }, 90_000)

  it('proxies both apps and the Vite HMR handshake through neem dev', async () => {
    const neem = spawnWithCapture([neemBin, 'dev'], fixtureDir, env)
    processes.push(neem)
    await waitFor(
      async () => {
        const response = await fetch(origin)
        return response.status === 200 &&
          (await response.text()).includes('neem-web-marker')
          ? true
          : false
      },
      90_000,
      () => `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`,
    )

    expect(await (await fetch(`${origin}/admin/`)).text()).toContain(
      'neem-admin-marker',
    )
    const messages: Array<{ type: unknown }> = []
    const socket = new WebSocket(
      `${origin.replace('http:', 'ws:')}/_nuxt/`,
      'vite-hmr',
    )
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const value: unknown = JSON.parse(event.data)
      if (value && typeof value === 'object' && 'type' in value) {
        messages.push({ type: value.type })
      }
    })
    await waitFor(
      () => messages.some((message) => message.type === 'connected'),
      15_000,
      () => `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`,
    )
    socket.close()
  }, 120_000)
})
