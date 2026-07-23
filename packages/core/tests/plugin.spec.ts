import { describe, expect, it } from 'vitest'

import type { ExecutionEnvironmentPlugin } from '../src/plugin.ts'
import { createPlugin } from '../src/plugin.ts'

describe('Plugin', () => {
  it('should create plugin', () => {
    const pluginName = 'test'
    const plugin = createPlugin({ name: pluginName })

    expect(plugin).toMatchObject<ExecutionEnvironmentPlugin>({
      name: pluginName,
    })
  })
})
