import type { ApplicationTransport } from '@nmtjs/application'

import { record } from './events.ts'

export const testTransport = {
  proxyable: undefined,
  async factory() {
    return {
      async start() {
        record({ event: 'transport:start' })
        return 'test://application'
      },
      async stop() {
        record({ event: 'transport:stop' })
      },
    }
  },
} satisfies ApplicationTransport<Record<string, never>>
