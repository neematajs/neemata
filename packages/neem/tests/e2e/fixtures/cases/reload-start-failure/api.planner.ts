import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [
    {
      port: Number.parseInt(
        process.env.NEEM_RELOAD_START_FAILURE_UPSTREAM_PORT ?? '0',
        10,
      ),
      failureDelayMs: Number.parseInt(
        process.env.NEEM_RELOAD_START_FAILURE_DELAY_MS ?? '1500',
        10,
      ),
    },
  ],
}))
