import { configDefaults, defineProject } from 'vitest/config'

const runtimeSpecificExclude = globalThis.Bun
  ? ['tests/**/*.node.spec.ts']
  : ['tests/**/*.bun.spec.ts']

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, ...runtimeSpecificExclude],
  },
})
