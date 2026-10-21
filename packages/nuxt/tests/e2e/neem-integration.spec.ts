import {
  access,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises'
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
    await access(
      resolve(fixtureDir, 'dist/runtime/web/worker/app/server/index.mjs'),
    )
    await access(
      resolve(fixtureDir, 'dist/runtime/admin/worker/app/server/index.mjs'),
    )
    await access(
      resolve(
        fixtureDir,
        'dist/runtime/web/worker/app/public/about/index.html',
      ),
    )
    // The admin app's deployment map settings hold: hidden browser maps,
    // none for Nitro.
    const adminApp = resolve(fixtureDir, 'dist/runtime/admin/worker/app')
    const adminScripts = await listFiles(resolve(adminApp, 'public/_nuxt'))
    const script = adminScripts.find((file) => file.endsWith('.js'))
    if (!script) throw new Error('Admin build emitted no JavaScript asset')
    expect(adminScripts).toContain(`${script}.map`)
    expect(
      await readFile(resolve(adminApp, 'public/_nuxt', script), 'utf8'),
    ).not.toContain('sourceMappingURL')
    expect(await listMaps(resolve(adminApp, 'server'))).toEqual([])
    // The web app sets no maps: Nuxt's production default links server maps.
    const webServer = resolve(fixtureDir, 'dist/runtime/web/worker/app/server')
    await expectLinkedServerMaps(webServer)
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

  it('serves a separately built preview with browser and server maps', async () => {
    const devBuildFile = resolve(fixtureDir, 'web/.nuxt/tsconfig.server.json')
    const devBuildWritten = (await stat(devBuildFile)).mtimeMs
    const neem = spawnWithCapture([neemBin, 'preview'], fixtureDir, env)
    processes.push(neem)
    const html = await waitFor(
      async () => {
        const response = await fetch(origin)
        const body = await response.text()
        return response.status === 200 && body.includes('neem-web-marker')
          ? body
          : false
      },
      180_000,
      () => `stdout:\n${neem.stdout()}\nstderr:\n${neem.stderr()}`,
    )

    await expect((await fetch(`${origin}/api/hello`)).json()).resolves.toEqual({
      message: 'hello-from-neem-api',
    })
    const adminHtml = await (await fetch(`${origin}/admin/`)).text()
    expect(adminHtml).toContain('neem-admin-marker')
    // The web app sets no maps, so preview links both sides; the admin app's
    // deployment settings (hidden browser maps, no Nitro maps) still apply.
    for (const [page, assets, linked] of [
      [html, /(?:src|href)="([^"]*\/_nuxt\/[^"]+\.js)"/, true],
      [adminHtml, /(?:src|href)="([^"]*\/admin\/_nuxt\/[^"]+\.js)"/, false],
    ] as const) {
      const asset = page.match(assets)?.[1]
      if (!asset) throw new Error('Preview HTML referenced no JavaScript asset')
      const assetUrl = new URL(asset, origin)
      const source = await (await fetch(assetUrl)).text()
      if (linked) {
        expect(source).toMatch(/\/\/# sourceMappingURL=\S+\.js\.map\s*$/)
      } else expect(source).not.toContain('sourceMappingURL')
      const map = await fetch(`${assetUrl.href}.map`)
      expect(map.status).toBe(200)
      const { sources } = (await map.json()) as { sources: string[] }
      expect(sources.length).toBeGreaterThan(0)
    }

    const previewRuntimes = resolve(
      fixtureDir,
      '.neem/preview/neem.config/runtime',
    )
    await expectLinkedServerMaps(
      resolve(previewRuntimes, 'web/worker/app/server'),
    )
    expect(
      await listMaps(resolve(previewRuntimes, 'admin/worker/app/server')),
    ).toEqual([])
    for (const runtime of ['web', 'admin']) {
      // Nuxt's intermediates stay with the preview output.
      await access(
        resolve(previewRuntimes, runtime, '.nuxt/tsconfig.server.json'),
      )
    }
    expect((await stat(devBuildFile)).mtimeMs).toBe(devBuildWritten)
    // The deployment build keeps Nuxt's production default: no browser maps.
    expect(
      await listMaps(
        resolve(fixtureDir, 'dist/runtime/web/worker/app/public/_nuxt'),
      ),
    ).toEqual([])
  }, 240_000)

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

async function listFiles(dir: string): Promise<string[]> {
  return await readdir(dir, { recursive: true })
}

async function expectLinkedServerMaps(serverDir: string): Promise<void> {
  expect(await readFile(resolve(serverDir, 'index.mjs'), 'utf8')).toMatch(
    /\/\/# sourceMappingURL=index\.mjs\.map\s*$/,
  )
  await access(resolve(serverDir, 'index.mjs.map'))
}

async function listMaps(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((file) => file.endsWith('.map'))
}
