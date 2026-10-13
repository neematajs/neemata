import { defineNativeWorkflowsPlanner } from '@nmtjs/workflows/native-effect/neem'

export default defineNativeWorkflowsPlanner(() => ({
  pools: { default: {}, render: {} },
}))
