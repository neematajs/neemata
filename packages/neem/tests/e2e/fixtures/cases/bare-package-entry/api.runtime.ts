import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'bare-package-entry',
  planner: '@fixture/bare-planner',
  worker: { entry: '@fixture/bare-worker' },
  host: { entry: '@fixture/bare-host' },
})
