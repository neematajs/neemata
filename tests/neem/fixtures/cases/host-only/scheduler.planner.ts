import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [],
  options: { fixture: 'host-only' },
}))
