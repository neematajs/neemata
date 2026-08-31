import { defineNeemataPlanner } from '@nmtjs/application/neem/planner'

export default defineNeemataPlanner(() => ({
  transports: { test: {} },
}))
