import { describe, expect, it } from 'vitest'
import { type Plugin, createPlugin } from '../lib/plugin.ts'

describe('Plugin', () => {
  it('should create plugin', () => {
    const pluginName = 'test'
    const plugin = createPlugin(pluginName, () => {})

    expect(plugin).toMatchObject<Plugin>({
      name: pluginName,
      init: expect.any(Function),
    })
  })
})
