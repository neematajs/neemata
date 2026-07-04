import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'non-file-url-worker' }],
  options: { fixture: 'non-file-url-entry' },
}))
