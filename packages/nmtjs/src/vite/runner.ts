import { createServerModuleRunner } from 'vite'

import type { NeemataConfig } from '../config.ts'
import type { ViteConfigOptions } from './config.ts'
import { createConfig } from './config.ts'
import { buildPlugins } from './plugins.ts'
import { createServer } from './server.ts'

export async function createRunner(
  options: ViteConfigOptions,
  mode: 'development' | 'production',
  neemataConfig: NeemataConfig,
) {
  const config = createConfig(options)
  const server = await createServer(options, {
    appType: 'custom',
    clearScreen: false,
    resolve: { alias: config.alias },
    mode,
    plugins: [...buildPlugins, ...neemataConfig.plugins],
  })
  const environment = server.environments.server
  const runner = createServerModuleRunner(environment, {
    hmr:
      mode === 'development'
        ? { logger: { debug: () => {}, error: console.error } }
        : false,
  })
  return runner
}
