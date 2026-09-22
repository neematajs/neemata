import { appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from 'vitest'

import type { SpawnedNeem } from './e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  spawnNeem,
  waitFor,
} from './e2e.ts'

export async function expectEnvironment(options: {
  paths?: string
  nodeEnv?: string
  expected: Record<string, string | undefined>
}) {
  const fixture = await createNeemFixture()
  let neem: SpawnedNeem | undefined
  try {
    await writeFile(
      resolve(fixture.dir, '.env'),
      'NEEM_TEST_FILE_VALUE=base\nNEEM_TEST_FALLBACK_VALUE=fallback\n',
    )
    await writeFile(
      resolve(fixture.dir, '.env.local'),
      'NEEM_TEST_FILE_VALUE=local\nNEEM_TEST_SHELL_VALUE=file\nNEEM_TEST_EXPANDED=${NEEM_TEST_FILE_VALUE}-expanded\n',
    )
    await writeFile(
      resolve(fixture.dir, 'custom.env'),
      'NEEM_TEST_FILE_VALUE=custom\nNEEM_TEST_EXTRA_VALUE=extra\n',
    )
    const expected = { NEEM_TEST_SHELL_VALUE: 'shell', ...options.expected }
    const checks = Object.entries(expected)
      .map(
        ([key, value]) =>
          `if (process.env[${JSON.stringify(key)}] !== ${JSON.stringify(value)}) throw new Error(${JSON.stringify(`Unexpected ${key}`)});`,
      )
      .join('\n')
    // Check both boundaries: config evaluation and the actual runtime worker.
    await appendFile(fixture.configFile, `\n${checks}\n`)
    await appendFile(
      fixture.appFile,
      `\n${checks}\nrecord({ event: 'env-checked' });\n`,
    )

    const args = [
      'dev',
      '--no-cache',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ]
    if (options.paths !== undefined) args.push('--env-files', options.paths)
    neem = spawnNeem(args, {
      cwd: fixture.dir,
      env: {
        NODE_ENV: options.nodeEnv ?? 'test',
        NEEM_TEST_FILE_VALUE: undefined,
        NEEM_TEST_EXPANDED: undefined,
        NEEM_TEST_FALLBACK_VALUE: undefined,
        NEEM_TEST_EXTRA_VALUE: undefined,
        NEEM_TEST_SHELL_VALUE: 'shell',
        NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
      },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitFor(async () =>
      (await readRuntimeEvents(fixture.eventsFile)).some(
        ({ event }) => event === 'env-checked',
      ),
    )
    expect(neem.stdout()).not.toContain('injecting env')
  } finally {
    await neem?.stop()
  }
}
