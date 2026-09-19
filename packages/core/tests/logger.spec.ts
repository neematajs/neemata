import { setImmediate } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { createConsolePrettyDestination } from '../src/logger.ts'

describe('createConsolePrettyDestination', () => {
  it('survives a level outside the built-in table', async () => {
    const { stream } = createConsolePrettyDestination('trace')
    const line = {
      level: 35,
      time: 0,
      msg: 'notice',
      $label: 'test',
      $threadId: 0,
    }

    stream.write(`${JSON.stringify(line)}\n`)
    await setImmediate()

    expect(stream).toHaveProperty('destroyed', false)
  })
})
