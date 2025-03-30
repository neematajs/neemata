import { describe, expect, it } from 'vitest'
import { kPlugin } from '../lib/constants.ts'
import { createPlugin, type Plugin } from '../lib/plugin.ts'

describe('Plugin', () => {
  it('should create plugin', () => {
    const pluginName = 'test'
    const plugin = createPlugin(pluginName, () => {})

    expect(plugin).toMatchObject<Plugin>({
      name: pluginName,
      init: expect.any(Function),
      [kPlugin]: expect.anything(),
    })
  })
})
