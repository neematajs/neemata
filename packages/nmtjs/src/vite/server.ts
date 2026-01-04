import type { DevEnvironmentOptions, UserConfig } from 'vite'
import { createServer as createViteServer } from 'vite'

import type { ViteConfigOptions } from './config.ts'

// Packages that must NOT be externalized to prevent module duplication.
// When externalized, Vite's ModuleRunner uses native Node import() which has
// a separate module cache from Vite's cache, causing the same module to be
// loaded twice with different object identities.
const noExternalPackages = ['nmtjs', /^@nmtjs\//]

export function createServer(
  options: ViteConfigOptions,
  config: UserConfig,
  dev: DevEnvironmentOptions = {},
) {
  return createViteServer({
    ...config,
    server: { middlewareMode: true, ws: false },
    resolve: { tsconfigPaths: true, ...config.resolve },
    environments: {
      neemata: {
        consumer: 'server',
        dev,
        resolve: {
          // Ensure nmtjs packages are not externalized in this environment
          noExternal: noExternalPackages,
        },
        define: {
          __VITE_CONFIG__: JSON.stringify(
            JSON.stringify({ options, mode: config.mode }),
          ),
          __APPLICATIONS_CONFIG__: JSON.stringify(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(options.applicationImports).map(
                  ([appName, { path, type }]) => [
                    appName,
                    { specifier: path, type },
                  ],
                ),
              ),
            ),
          ),
        },
      },
    },
  })
}
