import { expect } from 'vitest'

import type { Plugin } from '../src/plugin.ts'
import { createLogger } from '../src/logger.ts'
import { createPlugin } from '../src/plugin.ts'

export const testPlugin = (init: Plugin['init'] = () => {}) =>
  createPlugin('TestPlugin', init)

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
