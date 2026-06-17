import { existsSync } from 'node:fs'

import { defineRuntimePlanner } from '@nmtjs/neem'

export default defineRuntimePlanner(() => {
  const marker = process.env.NEEM_RECOVERY_PROXY_MARKER ?? ''
  const attempt = marker && existsSync(marker) ? 2 : 1
  const port = Number.parseInt(
    attempt === 1
      ? (process.env.NEEM_RECOVERY_PROXY_FIRST_PORT ?? '0')
      : (process.env.NEEM_RECOVERY_PROXY_SECOND_PORT ?? '0'),
    10,
  )

  return { workers: [{ attempt, marker, port }] }
})
