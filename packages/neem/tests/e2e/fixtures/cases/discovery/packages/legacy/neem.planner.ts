import { defineRuntimePlanner } from '../../neem.ts'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'excluded-legacy' }],
}))
