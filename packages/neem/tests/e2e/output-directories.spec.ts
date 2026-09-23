import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createNeemFixture,
  expectFile,
  runNeem,
  spawnNeem,
  updateFileAtomically,
  waitFor,
} from './support/e2e.ts'

describe('Neem output directories', () => {
  it('builds and starts configs sharing a directory from their own outDir', async () => {
    const fixture = await createNeemFixture()
    const configDir = dirname(fixture.configFile)
    const otherConfigFile = resolve(configDir, 'neem.other.config.ts')
    await writeFile(
      otherConfigFile,
      (await readFile(fixture.configFile, 'utf8')).replace(
        'defineConfig({',
        "defineConfig({\n  outDir: 'other-dist',",
      ),
    )
    // Run from outside the config directory: config paths must not follow cwd.
    const cwd = fixture.dir
    const config = relative(cwd, fixture.configFile)
    const otherConfig = relative(cwd, otherConfigFile)

    await runNeem(['build', '--config', config], { cwd })
    await runNeem(['build', '--config', otherConfig], { cwd })

    await expectFile(resolve(configDir, 'dist/neem.manifest.json'))
    await expectFile(resolve(configDir, 'other-dist/neem.manifest.json'))
    await expect(access(resolve(cwd, 'dist'))).rejects.toThrow()

    const neem = spawnNeem(['start', '--config', otherConfig], { cwd })
    const ready = await neem.waitForEvent(
      (event) => event.event === 'runtime:ready',
      30_000,
    )
    expect(ready).toBeDefined()
    await neem.stop()
  }, 60_000)

  it('keeps a running dev session when its config is built', async () => {
    const fixture = await createNeemFixture()
    const configDir = dirname(fixture.configFile)
    const cwd = fixture.dir
    const config = relative(cwd, fixture.configFile)
    const devManifest = resolve(
      configDir,
      '.neem/neem.config/neem.manifest.json',
    )

    const neem = spawnNeem(['dev', '--config', config], { cwd })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await expectFile(devManifest)

    await runNeem(['build', '--config', config], { cwd })

    await expectFile(resolve(configDir, 'dist/neem.manifest.json'))
    await expectFile(devManifest)
    await expectFile(resolve(configDir, '.neem/neem.config/runtime/start.js'))
    expect(neem.child.exitCode).toBeNull()
    expect(neem.child.signalCode).toBeNull()

    // Surviving files alone would not show that dev outlived the build.
    const threadStarts = () =>
      neem.events().filter((event) => event.event === 'runtime:thread-started')
        .length
    const startsBeforeEdit = threadStarts()
    await updateFileAtomically(
      resolve(configDir, 'api.planner.ts'),
      (content) => content.replace("label: 'one'", "label: 'changed'"),
    )
    await neem.waitForEvent(
      (event) =>
        event.event === 'watcher:runtime-changed' &&
        event.runtimeName === 'api',
      30_000,
    )
    await waitFor(() => threadStarts() >= startsBeforeEdit + 2, 30_000)
    await neem.stop()
  }, 60_000)
})
