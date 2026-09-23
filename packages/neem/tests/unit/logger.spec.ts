import { threadId } from 'node:worker_threads'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { childLogger, createDefaultLogger } from '../../src/internal/logger.ts'

afterEach(() => vi.unstubAllEnvs())

describe('Neem logger', () => {
  it('selects development and production defaults and accepts a level override', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(createDefaultLogger('development').level).toBe('debug')
    expect(createDefaultLogger('production').level).toBe('info')
    expect(
      createDefaultLogger('production', { pinoOptions: { level: 'trace' } })
        .level,
    ).toBe('trace')
  })

  it('routes levels independently and preserves labels, headers, and error causes', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const debugLines: string[] = []
    const errorLines: string[] = []
    const logger = createDefaultLogger('production', {
      destinations: [
        { level: 'debug', stream: { write: (line) => debugLines.push(line) } },
        { level: 'error', stream: { write: (line) => errorLines.push(line) } },
      ],
    })
    const child = childLogger(logger, 'runtime:api')

    child.debug({ headers: new Headers({ 'x-neem-test': 'value' }) }, 'ready')
    child.error(new Error('outer', { cause: new Error('inner') }))

    expect(debugLines).toHaveLength(2)
    expect(errorLines).toHaveLength(1)
    expect(JSON.parse(debugLines[0])).toMatchObject({
      $label: 'runtime:api',
      $threadId: threadId,
      headers: { 'x-neem-test': 'value' },
      msg: 'ready',
    })
    expect(JSON.parse(errorLines[0])).toMatchObject({
      err: { message: 'outer', cause: { message: 'inner' } },
    })
    expect(logger.bindings().$label).toBe('neem')
  })

  it('accepts a plain destination stream using the info threshold', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const lines: string[] = []
    const logger = createDefaultLogger('production', {
      destinations: [{ write: (line) => lines.push(line) }],
    })

    logger.debug('hidden')
    logger.info('visible')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('visible')
  })

  it('disables the default logger during tests', () => {
    vi.stubEnv('NODE_ENV', 'test')
    expect(createDefaultLogger().isLevelEnabled('fatal')).toBe(false)
  })
})
