import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => ({
  workers: [
    {
      label: 'api',
      port: Number.parseInt(process.env.NEEM_PROXY_UPSTREAM_PORT ?? '0', 10),
    },
  ],
}))
