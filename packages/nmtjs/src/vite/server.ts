import type { DevEnvironmentOptions, UserConfig } from 'vite'
import { createServer as createViteServer } from 'vite'

import type { ViteConfigOptions } from './config.ts'

export function createServer(
  options: ViteConfigOptions,
  config: UserConfig,
  dev: DevEnvironmentOptions = {},
) {
  return createViteServer({
    ...config,
    server: { middlewareMode: true, ws: false },
    environments: {
      neemata: {
        consumer: 'server',
        dev,
        define: {
          __VITE_CONFIG__: JSON.stringify(
            JSON.stringify({ options, mode: config.mode }),
          ),
          __APPLICATIONS_CONFIG__: JSON.stringify(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(options.applicationImports).map(
                  ([appName, { path }]) => [appName, path],
                ),
              ),
            ),
          ),
        },
      },
    },
  })
}
