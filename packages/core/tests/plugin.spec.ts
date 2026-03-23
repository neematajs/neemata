import { describe, expect, it } from 'vitest'

import type { Plugin } from '../src/plugin.ts'
import { kPlugin } from '../src/constants.ts'
import { createPlugin } from '../src/plugin.ts'

describe('Plugin', () => {
  it('should create plugin', () => {
    const pluginName = 'test'
    const plugin = createPlugin(pluginName, () => {})

    expect(plugin).toMatchObject<Plugin>({
      name: pluginName,
      factory: expect.any(Function),
      [kPlugin]: expect.anything(),
    })
  })
})
