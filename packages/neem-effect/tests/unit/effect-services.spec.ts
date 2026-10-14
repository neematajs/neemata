import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'

import { hostSettings } from '../../src/internal/config.ts'
import { applyHostConfigEnvOverrides } from '../../src/internal/env-config.ts'
import { loadEnvFiles } from '../../src/internal/env-files.ts'
import { createHostHooks } from '../../src/internal/hooks.ts'
import { Deadline, Lifetime } from '../../src/internal/lifetime.ts'
import { acquirePlugins } from '../../src/internal/plugins.ts'
import { callbackRunner } from '../../src/internal/tasks.ts'
import { createSupervisor } from './support/runtime.ts'

const logger = pino({ enabled: false })

describe('Effect service ownership', () => {
  it('uses the provided monotonic clock even when wall time moves backwards', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const deadline = yield* Deadline.make(1000)
        yield* TestClock.adjust(250)
        expect(deadline.remaining()).toBe(750)
        yield* TestClock.setTime(-10_000)
        expect(deadline.remaining()).toBe(750)
        yield* TestClock.adjust(750)
        expect(deadline.remaining()).toBe(0)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  it('captures callback services and interrupts owned work on close', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(1234)
        const lifetime = Lifetime.make(1000)
        lifetime.clock = yield* Clock.Clock
        const run = yield* callbackRunner(lifetime)
        const started = Deferred.makeUnsafe<number>()
        let released = false
        run(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, yield* Clock.currentTimeMillis)
            yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released = true
              }),
            ),
          ),
        )
        expect(yield* Deferred.await(started)).toBe(1234)
        expect(yield* lifetime.close(yield* Deadline.make(1000))).toEqual([])
        expect(released).toBe(true)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  it('does not invoke later hooks after interrupting a pending promise hook', async () => {
    const hooks = createHostHooks()
    const started = Deferred.makeUnsafe<void>()
    let finish!: () => void
    let later = false
    hooks.hook(
      'initialize',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
          Deferred.doneUnsafe(started, Effect.void)
        }),
    )
    hooks.hook('initialize', () => {
      later = true
    })
    const calling = Effect.runFork(
      hooks.call(logger, 'initialize', { mode: 'production' }),
    )
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(calling))
    finish()
    await Promise.resolve()
    expect(later).toBe(false)
  })

  it('runs all hooks in order and reports all failures', async () => {
    const hooks = createHostHooks(),
      seen: number[] = []
    hooks.hook('dispose', () => {
      seen.push(1)
      throw new Error('first')
    })
    hooks.hook('dispose', () =>
      Effect.sync(() => {
        seen.push(2)
      }),
    )
    hooks.hook('dispose', async () => {
      seen.push(3)
      throw new Error('last')
    })
    await expect(
      Effect.runPromise(hooks.call(logger, 'dispose', { mode: 'production' })),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'first' }),
        expect.objectContaining({ message: 'last' }),
      ],
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('owns resources acquired by an Effect plugin factory', async () => {
    const seen: string[] = []
    const key = 'neem-effect-scoped-plugin-test'
    Reflect.set(globalThis, key, seen)
    try {
      const { snapshot } = createSupervisor({ plan: [] })
      snapshot.outDir = fileURLToPath(new URL('./fixtures/', import.meta.url))
      snapshot.manifest.plugins = [
        { name: 'scoped', entry: { file: 'plugin.ts' }, options: { key } },
      ]
      const lifetime = Lifetime.make(1000)
      await Effect.runPromise(
        acquirePlugins(snapshot, createHostHooks(), lifetime, () => {
          throw new Error('unused')
        }),
      )
      expect(seen).toEqual(['acquire'])
      expect(
        await Effect.runPromise(lifetime.close(Deadline.after(1000))),
      ).toEqual([])
      expect(seen).toEqual(['acquire', 'dispose', 'release'])
    } finally {
      Reflect.deleteProperty(globalThis, key)
    }
  })

  it('disposes acquired plugins when a later factory fails, then external hooks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-effect-plugins-'))
    const seen: string[] = []
    const key = `neem-effect-plugin-${dir}`
    Reflect.set(globalThis, key, seen)
    try {
      await writeFile(
        join(dir, 'first.mjs'),
        `export default () => ({ dispose() { globalThis[${JSON.stringify(key)}].push('plugin') } })`,
      )
      await writeFile(
        join(dir, 'broken.mjs'),
        `export default () => { throw new Error('factory failed') }`,
      )
      const { snapshot } = createSupervisor({ plan: [] })
      snapshot.outDir = dir
      snapshot.manifest.plugins = [
        { name: 'first', entry: { file: 'first.mjs' } },
        { name: 'broken', entry: { file: 'broken.mjs' } },
      ]
      const hooks = createHostHooks(),
        lifetime = Lifetime.make(1000)
      hooks.hook('dispose', () => {
        seen.push('external')
      })
      await expect(
        Effect.runPromise(
          acquirePlugins(snapshot, hooks, lifetime, () => {
            throw new Error('unused')
          }),
        ),
      ).rejects.toThrow('factory failed')
      expect(
        await Effect.runPromise(lifetime.close(Deadline.after(1000))),
      ).toEqual([])
      expect(seen).toEqual(['plugin', 'external'])
    } finally {
      Reflect.deleteProperty(globalThis, key)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Effect configuration', () => {
  it.each(['0', '-1', '10ms', '1.5', 'no'])(
    'rejects malformed request timeout %s',
    async (value) => {
      await expect(
        Effect.runPromise(
          hostSettings({ NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS: value }),
        ),
      ).rejects.toThrow('Invalid Neem host configuration')
    },
  )
  it('uses defaults and validates tracing independently', async () => {
    expect(await Effect.runPromise(hostSettings({}))).toEqual({
      requestTimeout: 30_000,
      tracing: false,
    })
    expect(
      await Effect.runPromise(
        hostSettings({
          NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS: '500',
          NEEM_EFFECT_TRACING: 'true',
        }),
      ),
    ).toEqual({ requestTimeout: 500, tracing: true })
    await expect(
      Effect.runPromise(hostSettings({ NEEM_EFFECT_TRACING: 'perhaps' })),
    ).rejects.toThrow()
  })
  it('preserves explicit Neem port precedence, including zero', () => {
    const config = { runtimes: {}, server: { port: 3000 } }
    expect(
      applyHostConfigEnvOverrides(config, {
        NEEM_SERVER_PORT: '0',
        PORT: '4000',
      }).config.server?.port,
    ).toBe(0)
    expect(config.server.port).toBe(3000)
    expect(() =>
      applyHostConfigEnvOverrides(config, { PORT: '4000junk' }),
    ).toThrow()
    expect(() =>
      applyHostConfigEnvOverrides(config, { NEEM_SERVER_TLS_KEY_PATH: '/key' }),
    ).toThrow('Both')
  })
  it('loads plain dotenv files in order without overwriting existing environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-effect-env-'))
    const prefix = 'NEEM_EFFECT_ENV_TEST'
    const keys = [
      prefix,
      `${prefix}_CHILD`,
      `${prefix}_EMPTY`,
      `${prefix}_EXISTING`,
    ]
    process.env[keys[3]!] = 'shell'
    try {
      const first = join(dir, 'first.env'),
        second = join(dir, 'second.env')
      await writeFile(
        first,
        `${prefix}=root\n${prefix}_CHILD="first value"\n${prefix}_EMPTY=\n${prefix}_EXISTING=file\n`,
      )
      await writeFile(second, `${prefix}_CHILD=second\n`)
      await Effect.runPromise(loadEnvFiles([first, second]))
      expect(keys.map((key) => process.env[key])).toEqual([
        'root',
        'first value',
        '',
        'shell',
      ])
    } finally {
      for (const key of keys) delete process.env[key]
      await rm(dir, { recursive: true, force: true })
    }
  })
})
