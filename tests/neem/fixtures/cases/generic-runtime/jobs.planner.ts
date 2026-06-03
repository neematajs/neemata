import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'planned' }, { label: 'planned' }],
  options: { queue: 'runtime' },
}))
