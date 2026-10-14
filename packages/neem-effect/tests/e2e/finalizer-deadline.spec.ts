import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { expect, it } from 'vitest'

import {
  readRuntimeEvents,
  runNeem,
  spawnNeem,
} from '../../../neem/tests/e2e/support/e2e.ts'
import { createTempDir } from '../../../neem/tests/support/temp.ts'

it('bounds an uninterruptible application finalizer while releasing a sibling worker', async () => {
  // Resolve the application preset from its own package, as in its existing e2e suite.
  const dir = await createTempDir(
    '.tmp-effect-deadline-',
    resolve(import.meta.dirname, '../../../effect/tests'),
  )
  const eventsFile = resolve(dir, 'events.jsonl')
  await writeFile(
    resolve(dir, 'neem.config.ts'),
    `
    import { defineConfig } from '@nmtjs/neem'
    export default defineConfig({
      lifecycle: { stopTimeout: 400 },
      runtimes: ['./app.runtime.ts'],
    })
  `,
  )
  await writeFile(
    resolve(dir, 'app.runtime.ts'),
    `import { defineRuntime } from '@nmtjs/neem'
    export default defineRuntime({ name: 'app', planner: './planner.ts', worker: { entry: './worker.ts' } })`,
  )
  await writeFile(
    resolve(dir, 'planner.ts'),
    `
    import { defineRuntimePlanner } from '@nmtjs/neem'
    export default defineRuntimePlanner(() => ({ workers: [{}, {}] }))
  `,
  )
  await writeFile(
    resolve(dir, 'worker.ts'),
    `
    import { appendFileSync } from 'node:fs'
    import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
    import * as Effect from 'effect/Effect'
    import * as Layer from 'effect/Layer'
    const record = (event, name) => appendFileSync(process.env.EFFECT_EVENTS_FILE, JSON.stringify({ event, name }) + String.fromCharCode(10))
    export default defineEffectWorker((ctx) => ({
      layer: Layer.empty,
      main: (ready) => Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.gen(function* () {
          record('finalizing', ctx.name)
          if (ctx.name.endsWith(':0')) yield* Effect.never
          record('released', ctx.name)
        }))
        yield* ready()
        yield* Effect.never
      }),
    }))
  `,
  )
  await runNeem(['build'], { cwd: dir })
  const host = spawnNeem(['start'], {
    cwd: dir,
    env: { EFFECT_EVENTS_FILE: eventsFile },
  })
  await host.waitForEvent((event) => event.event === 'runtime:ready')

  const started = performance.now()
  const exit = await host.stop({ killAfterMs: 3_000 })
  expect(exit, host.stderr()).toEqual({ code: 1, signal: null })
  expect(performance.now() - started).toBeLessThan(2_000)
  const events = await readRuntimeEvents(eventsFile)
  expect(events.filter((event) => event.event === 'finalizing')).toHaveLength(2)
  expect(events.filter((event) => event.event === 'released')).toEqual([
    expect.objectContaining({ name: 'app:1' }),
  ])
}, 60_000)
