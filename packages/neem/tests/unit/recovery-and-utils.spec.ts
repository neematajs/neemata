import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  createRecoveryPolicy,
  getRecoveryDelay,
} from '../../src/internal/host/recovery.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../../src/internal/shared/runtime-selection.ts'
import {
  deserializeError,
  raceWithTimeout,
  sanitizePathPart,
  serializeError,
  toFilePath,
} from '../../src/internal/shared/utils.ts'

const execFileAsync = promisify(execFile)

describe('runtime recovery policy', () => {
  it('uses dev and production defaults', () => {
    expect(createRecoveryPolicy('development')).toEqual({
      attempts: 0,
      delayMs: 0,
      factor: 1,
      maxDelayMs: 0,
    })
    expect(createRecoveryPolicy('production')).toEqual({
      attempts: 3,
      delayMs: 1_000,
      factor: 1,
      maxDelayMs: 1_000,
    })
  })

  it('normalizes invalid override values and caps exponential delay', () => {
    const policy = createRecoveryPolicy('production', {
      attempts: 2.8,
      delayMs: 50,
      factor: 3,
      maxDelayMs: 120,
    })

    expect(policy.attempts).toBe(2)
    expect(getRecoveryDelay(policy, 1)).toBe(50)
    expect(getRecoveryDelay(policy, 2)).toBe(120)
    expect(
      createRecoveryPolicy('development', {
        attempts: -1,
        delayMs: Number.NaN,
        factor: 0,
        maxDelayMs: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ attempts: 0, delayMs: 0, factor: 1, maxDelayMs: 0 })
  })
})

describe('runtime selection helpers', () => {
  it('trims runtime names and treats empty selections as all runtimes', () => {
    expect(normalizeRuntimeNames(undefined)).toBeUndefined()
    expect(normalizeRuntimeNames([' ', 'api', ' jobs '])).toEqual([
      'api',
      'jobs',
    ])
    expect(normalizeRuntimeNames(['', '  '])).toBeUndefined()
  })

  it('reports all unknown runtime names', () => {
    expect(() =>
      assertRuntimeNamesExist(['api', 'missing', 'ghost'], ['api']),
    ).toThrow('Unknown Neem runtime(s): missing, ghost')
  })
})

describe('shared utilities', () => {
  it('sanitizes path parts without producing empty names', () => {
    expect(sanitizePathPart(' @scope/runtime one ')).toBe('scope-runtime-one')
    expect(sanitizePathPart('///')).toBe('item')
  })

  it('serializes and deserializes errors', () => {
    const error = new TypeError('bad type')
    const serialized = serializeError(error)
    const deserialized = deserializeError(serialized)

    expect(serialized).toMatchObject({ name: 'TypeError', message: 'bad type' })
    expect(deserialized).toBeInstanceOf(Error)
    expect(deserialized).toMatchObject({
      name: 'TypeError',
      message: 'bad type',
    })
  })

  it('resolves paths, URL paths, and file URL strings', () => {
    expect(toFilePath('./config.ts', '/workspace/app')).toBe(
      '/workspace/app/config.ts',
    )
    expect(toFilePath(new URL('file:///workspace/app/config.ts'))).toBe(
      '/workspace/app/config.ts',
    )
    expect(toFilePath('file:///workspace/app/config.ts')).toBe(
      '/workspace/app/config.ts',
    )
  })

  it('races promises with timeout', async () => {
    await expect(
      raceWithTimeout(Promise.resolve('ok'), 5_000),
    ).resolves.toEqual({ timedOut: false, value: 'ok' })
    await expect(raceWithTimeout(new Promise(() => {}), 1)).resolves.toEqual({
      timedOut: true,
    })
  })

  it('does not keep the process alive after fast race completion', async () => {
    const entry = new URL('../../src/internal/shared/utils.ts', import.meta.url)
    const script = `
      const { raceWithTimeout } = await import(${JSON.stringify(entry.href)})
      const result = await raceWithTimeout(Promise.resolve('ok'), 5_000)
      console.log(JSON.stringify(result))
    `

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { timeout: 2_000 },
    )

    expect(JSON.parse(stdout)).toEqual({ timedOut: false, value: 'ok' })
  })
})
