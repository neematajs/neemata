import { defineRuntimePlanner } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimePlanner((ctx) => {
  record({ event: 'file-url-planner', name: ctx.name, mode: ctx.mode })

  return {
    workers: [{ label: 'file-url-worker' }],
    options: { fixture: 'file-url-entry' },
  }
})
