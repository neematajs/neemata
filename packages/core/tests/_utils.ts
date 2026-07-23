import { expect } from 'vitest'

import { createLogger } from '../src/logger.ts'

export const testLogger = () =>
  createLogger({ pinoOptions: { enabled: false } }, 'test')

export const expectCopy = (source, targer) => {
  expect(targer).not.toBe(source)
  expect(targer).toEqual(source)
}
