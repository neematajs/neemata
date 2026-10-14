import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createTempDir } from '../support/temp.ts'
import { getFreePort, runNeem, spawnNeem, waitFor } from './support/e2e.ts'

async function fixture() {
  const vitePackage = resolve(import.meta.dirname, '../../../vite')
  // Keep Vite resolvable from the application without adding it to Neem's dependencies.
  const cwd = await createTempDir('neem-', resolve(vitePackage, 'tests/.tmp'))
  await cp(resolve(vitePackage, 'playground'), cwd, {
    recursive: true,
    filter: (path) =>
      !['dist', '.neem', 'node_modules', 'tsconfig.json'].includes(
        basename(path),
      ),
  })
  const port = await getFreePort()
  return {
    cwd,
    env: { NEEM_SERVER_PORT: String(port) },
    origin: `http://127.0.0.1:${port}`,
  }
}

describe('Vite preset through the canonical Neem CLI', () => {
  it('builds and serves default and path-routed applications with their assets', async () => {
    const { cwd, env, origin } = await fixture()
    await runNeem(['build'], { cwd, env })
    const neem = spawnNeem(['start'], { cwd, env })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    for (const base of ['/', '/admin/']) {
      const response = await fetch(`${origin}${base}`)
      expect(response.status).toBe(200)
      const html = await response.text()
      const asset = html.match(/src="([^"]+\.js)"/)?.[1]
      expect(asset).toBeDefined()
      const script = await fetch(new URL(asset!, origin))
      expect(script.status).toBe(200)
      expect(await script.text()).toContain(
        base === '/' ? 'playground' : 'path-routed',
      )
    }
    expect(await neem.stop({ killAfterMs: 10_000 })).toEqual({
      code: 0,
      signal: null,
    })
  }, 60_000)

  it('serves both development apps and forwards HMR updates through the proxy', async () => {
    const { cwd, env, origin } = await fixture()
    const neem = spawnNeem(['dev'], { cwd, env })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    for (const base of ['/', '/admin/']) {
      expect((await fetch(`${origin}${base}`)).status).toBe(200)
      expect(
        await (await fetch(`${origin}${base}src/main.ts`)).text(),
      ).toContain('import.meta.hot')
    }
    const messages: Array<{ type: string }> = []
    const socket = new WebSocket(origin.replace('http:', 'ws:'), 'vite-hmr')
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') messages.push(JSON.parse(event.data))
    })
    try {
      await waitFor(() =>
        messages.some((message) => message.type === 'connected'),
      )
      const file = resolve(cwd, 'src/main.ts')
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace(
          'served through',
          'updated through',
        ),
      )
      await waitFor(
        () => messages.some((message) => message.type === 'update'),
        10_000,
        neem.stderr,
      )
      expect(await (await fetch(`${origin}/src/main.ts`)).text()).toContain(
        'updated through',
      )
    } finally {
      socket.close()
    }
    expect(await neem.stop({ killAfterMs: 10_000 })).toEqual({
      code: 0,
      signal: null,
    })
  }, 60_000)
})
