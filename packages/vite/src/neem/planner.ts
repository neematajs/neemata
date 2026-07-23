import { defineRuntimePlanner } from '@nmtjs/neem'

// A Vite app is one server per runtime: a single dev server in development
// (HMR state is per-instance), a single static server in production. Scale
// out happens behind the Neem proxy, not inside the plan.
export default defineRuntimePlanner(() => ({ workers: [{}] }))
