import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: Array.from(
    { length: Number(process.env.NEEM_BENCH_WORKERS ?? 1) },
    (_, index) => ({ index }),
  ),
}))
