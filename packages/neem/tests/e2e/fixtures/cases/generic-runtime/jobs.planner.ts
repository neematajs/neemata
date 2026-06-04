import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [{ label: 'planned' }, { label: 'planned' }],
  options: { queue: 'runtime', env: pickEnv() },
}))

function pickEnv() {
  return {
    rootOnly: process.env.NEEM_ENV_ROOT_ONLY,
    runtimeOnly: process.env.NEEM_ENV_RUNTIME_ONLY,
    layered: process.env.NEEM_ENV_LAYERED,
    executionOverride: process.env.NEEM_ENV_EXECUTION_OVERRIDE,
  }
}
