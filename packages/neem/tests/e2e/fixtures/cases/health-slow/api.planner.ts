import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'slow', startDelayMs: 2_000 }],
}))
