import type { UserConfig } from 'vite'
import { createServer as createViteServer } from 'vite'

import type { ViteConfigOptions } from './config.ts'

export function createServer(options: ViteConfigOptions, config: UserConfig) {
  return createViteServer({
    ...config,
    server: { middlewareMode: true, ws: false },
    logLevel: 'error',

    environments: {
      server: {
        consumer: 'server',
        dev: {},
        define: {
          VITE_CONFIG: JSON.stringify(
            JSON.stringify({ options, mode: config.mode }),
          ),
        },
      },
    },
  })
}
