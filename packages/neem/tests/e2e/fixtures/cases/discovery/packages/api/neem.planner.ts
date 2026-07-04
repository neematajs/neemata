import { defineRuntimePlanner } from '../../neem.ts'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'discovered-api' }],
  options: { fixture: 'discovery' },
}))
