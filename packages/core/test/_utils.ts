import { expect } from 'vitest'
import { createLogger } from '../lib/logger.ts'
import { createPlugin, type Plugin } from '../lib/plugin.ts'

export const testPlugin = (init: Plugin['init'] = () => {}) =>
  createPlugin('TestPlugin', init)

export const testLogger = () =>
  createLogger(
    {
      pinoOptions: { enabled: false },
    },
    'test',
  )

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
