import { defineRuntimePlanner } from '@nmtjs/neem'

// A Nuxt app is one server per runtime: a single dev pipeline in development
// (HMR state is per-instance), a single nitro server in production. Scale
// out happens behind the Neem proxy, not inside the plan.
export default defineRuntimePlanner(() => ({ workers: [{}] }))
