import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createNeemFixture, runNeem, spawnNeem } from './support/e2e.ts'

describe('Neem logger flush', () => {
  it('flushes the manifest logger of every thread before neem start exits', async () => {
    const fixture = await createNeemFixture({ config: 'logger-flush' })
    const flushFile = resolve(fixture.dir, 'flushed.jsonl')
    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const neem = spawnNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_LOG_FLUSH_FILE: flushFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    expect(await neem.stop()).toEqual({ code: 0, signal: null })

    const messages = (await readFile(flushFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { msg: string }).msg)
    // The last line each thread logs before it exits: runtime worker, host
    // runner and the in-process host.
    expect(messages).toEqual(
      expect.arrayContaining([
        'Neem runtime worker stopped',
        'Neem host runner shutting down',
        'Neem server stopped',
      ]),
    )
  }, 60_000)
})
