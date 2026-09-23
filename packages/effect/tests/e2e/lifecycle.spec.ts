import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import type { SpawnedNeem } from '../../../neem/tests/e2e/support/e2e.ts'
import { spawnNeem, waitFor } from '../../../neem/tests/e2e/support/e2e.ts'

const directories: string[] = []
const processes: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.stop()))
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function fixture() {
  const dir = await mkdtemp(resolve(import.meta.dirname, '../.tmp-effect-'))
  directories.push(dir)
  await cp(resolve(import.meta.dirname, '../fixtures'), dir, {
    recursive: true,
  })
  const eventsFile = resolve(dir, 'events.jsonl')
  const env = { EFFECT_EVENTS_FILE: eventsFile }
  const run = (command: string, extra: NodeJS.ProcessEnv = {}) => {
    const process = spawnNeem([command], {
      cwd: dir,
      env: { ...env, ...extra },
    })
    processes.push(process)
    return process
  }
  const events = async (): Promise<
    Array<{ event: string; marker: string; url?: string }>
  > => {
    const text = await readFile(eventsFile, 'utf8').catch(() => '')
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return { dir, run, events }
}

it('builds, serves HTTP after readiness, and shuts down the scoped server', async () => {
  const app = await fixture()
  const build = app.run('build')
  expect(await build.waitForExit(), build.stderr()).toEqual({
    code: 0,
    signal: null,
  })
  const server = app.run('start')
  await server.waitForEvent((event) => event.event === 'runtime:ready')
  const started = (await app.events()).find(
    (event) => event.event === 'started',
  )!
  expect(await (await fetch(started.url!)).text()).toBe('effect-v1')
  expect(await server.stop()).toEqual({ code: 0, signal: null })
  expect(
    (await app.events()).filter((event) => event.event === 'stopped'),
  ).toHaveLength(1)
  await expect(fetch(started.url!)).rejects.toThrow()
})

it('recovers a worker whose supervised main fails', async () => {
  const app = await fixture()
  const build = app.run('build')
  expect(await build.waitForExit(), build.stderr()).toEqual({
    code: 0,
    signal: null,
  })
  const server = app.run('start', {
    EFFECT_FAILURE_FILE: resolve(app.dir, 'failed-once'),
  })
  await waitFor(
    async () =>
      (await app.events()).filter((event) => event.event === 'started')
        .length === 2,
    30_000,
    server.stderr,
  )
  const events = await app.events()
  expect(events.filter((event) => event.event === 'stopped')).toHaveLength(1)
  const restarted = events.filter((event) => event.event === 'started')[1]
  expect(await (await fetch(restarted.url!)).text()).toBe('effect-v1')
  await server.stop()
  expect(
    (await app.events()).filter((event) => event.event === 'stopped'),
  ).toHaveLength(2)
})

it('releases the old Effect scope when the worker artifact reloads', async () => {
  const app = await fixture()
  const server = app.run('dev')
  await server.waitForEvent((event) => event.event === 'runtime:ready')
  const old = (await app.events()).find((event) => event.event === 'started')!
  const entry = resolve(app.dir, 'app.worker.ts')
  await writeFile(
    entry,
    (await readFile(entry, 'utf8')).replace('effect-v1', 'effect-v2'),
  )
  await waitFor(
    async () =>
      (await app.events()).some(
        (event) => event.event === 'started' && event.marker === 'effect-v2',
      ),
    30_000,
    server.stderr,
  )
  const events = await app.events()
  expect(
    events.some(
      (event) => event.event === 'stopped' && event.marker === 'effect-v1',
    ),
  ).toBe(true)
  const current = events.find(
    (event) => event.event === 'started' && event.marker === 'effect-v2',
  )!
  expect(await (await fetch(current.url!)).text()).toBe('effect-v2')
  await expect(fetch(old.url!)).rejects.toThrow()
})
