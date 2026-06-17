import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'duplicate' }],
}))
