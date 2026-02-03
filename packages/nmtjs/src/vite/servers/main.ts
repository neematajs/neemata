import type { UserConfig, ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import { noopFn } from '@nmtjs/common'
import { createServerModuleRunner, mergeConfig } from 'vite'

import type { NeemataConfig } from '../../config.ts'
import type { ViteConfigOptions } from '../config.ts'
import { createConfig } from '../config.ts'
import { plugins } from '../plugins.ts'
import { createServer } from '../server.ts'

export async function createMainServer(
  options: ViteConfigOptions,
  mode: 'development' | 'production',
  { vite }: NeemataConfig,
): Promise<{ server: ViteDevServer; runner: ModuleRunner }> {
  const config = createConfig(options)
  const server = await createServer(
    options,
    mergeConfig(
      {
        appType: 'custom',
        clearScreen: false,
        resolve: { alias: config.alias, noExternal: ['@nmtjs/proxy'] },
        mode,
        plugins: [...plugins],
        optimizeDeps: { noDiscovery: true },
      } satisfies UserConfig,
      vite,
    ),
  )
  const environment = server.environments.neemata

  const runner = createServerModuleRunner(environment, {
    hmr:
      mode === 'development'
        ? { logger: { debug: noopFn, error: console.error } }
        : false,
  })
  return { server, runner }
}
