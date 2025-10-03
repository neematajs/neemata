import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*'],
    env: { NODE_OPTIONS: '--expose-gc' },
    open: false,
  },
})
