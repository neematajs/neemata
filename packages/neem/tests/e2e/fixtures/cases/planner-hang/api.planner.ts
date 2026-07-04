import { defineRuntimePlanner } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

export default defineRuntimePlanner(async (ctx) => {
  record({ event: 'planner-hang-start', name: ctx.name })
  await new Promise(() => {})
  return { workers: [] }
})
