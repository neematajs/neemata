import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Cause from 'effect/Cause'
import { Command } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it, vi } from 'vitest'

import { createMainCommand, type CommandActions } from '../../../src/cli.ts'
import { cliAction } from '../../../src/internal/cli-action.ts'

function cli() {
  const actions = {
    build: vi.fn<CommandActions['build']>(async () => {}),
    dev: vi.fn<CommandActions['dev']>(async () => {}),
    start: vi.fn<CommandActions['start']>(async () => {}),
  }
  const run = Command.runWith(createMainCommand(actions), {
    version: '1.0.0',
    renderErrors: false,
  })
  return {
    actions,
    run: (args: string[]) =>
      Effect.runPromise(run(args).pipe(Effect.provide(NodeServices.layer))),
  }
}

describe('Effect CLI', () => {
  it('defaults development config and cache, without making start evaluate a config', async () => {
    const { actions, run } = cli()
    await run(['dev'])
    expect(actions.dev.mock.calls[0]?.[0]).toEqual({
      config: 'neem.config.ts',
      cache: true,
      runtime: undefined,
      outDir: undefined,
      cacheDir: undefined,
      'env-files': undefined,
    })
    await run(['start'])
    expect(actions.start.mock.calls[0]?.[0]).toEqual({
      config: undefined,
      runtime: undefined,
      outDir: undefined,
    })
  })

  it.each(['--out-dir', '--outDir'])(
    'parses runtime selection, aliases, env files and cache negation (%s)',
    async (flag) => {
      const { actions, run } = cli()
      await run([
        'dev',
        'api,jobs',
        '--config',
        'custom.ts',
        flag,
        'custom-output',
        '--no-cache',
        '--cacheDir',
        'cache',
        '--env-files',
        '.env,.env.local',
      ])
      expect(actions.dev.mock.calls[0]?.[0]).toEqual({
        config: 'custom.ts',
        runtime: 'api,jobs',
        outDir: 'custom-output',
        cache: false,
        cacheDir: 'cache',
        'env-files': '.env,.env.local',
      })
    },
  )

  it('rejects unknown flags before running a build', async () => {
    const { actions, run } = cli()
    await expect(run(['build', '--typo'])).rejects.toThrow()
    expect(actions.build).not.toHaveBeenCalled()
  })

  it('waits for the aborted action to finish cleanup', async () => {
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const fiber = Effect.runFork(
      cliAction(async (signal) => {
        signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        })
        entered.resolve()
        await aborted.promise
        await cleanup.promise
      }),
    )
    await entered.promise
    let settled = false
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      settled = true
    })
    await aborted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(settled).toBe(false)
    } finally {
      cleanup.resolve()
    }
    await interrupt
    expect(settled).toBe(true)
  })

  it('retains cleanup failure after interruption so the process exits unsuccessfully', async () => {
    const entered = Promise.withResolvers<void>()
    const failure = new Error('cleanup failed')
    const fiber = Effect.runFork(
      cliAction(async (signal) => {
        const aborted = new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        entered.resolve()
        await aborted
        throw failure
      }),
    )
    await entered.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isDieReason(reason) && reason.defect === failure,
        ),
      ).toBe(true)
    }
  })
})
