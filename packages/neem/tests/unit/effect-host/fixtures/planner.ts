import { defineRuntimePlanner } from '@nmtjs/neem'

// The test passes its plan through the runtime environment.
export default defineRuntimePlanner(() => ({
  workers: JSON.parse(process.env.NEEM_EFFECT_TEST_PLAN ?? '[]') as unknown[],
}))
