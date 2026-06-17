import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [
    { label: 'started' },
    { label: 'failing', fail: true, startDelayMs: 75 },
  ],
}))
