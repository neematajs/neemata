import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

import type { UserConfig } from 'vite'
import { mergeConfig, build as viteBuild } from 'vite'

import type { NeemataConfig } from '../config.ts'
import type { ViteConfigOptions } from './config.ts'
import { createConfig } from './config.ts'
import { plugins } from './plugins.ts'

export async function createBuilder(
  configOptions: ViteConfigOptions,
  neemataConfig: NeemataConfig,
) {
  const config = createConfig(configOptions)
  async function build(): Promise<any> {
    const packageJson = await import(resolve('./package.json'), {
      with: { type: 'json' },
    }).then((mod) => mod.default)

    return await viteBuild(
      mergeConfig(
        {
          appType: 'custom',
          clearScreen: false,
          resolve: { alias: config.alias, noExternal: ['@nmtjs/proxy'] },
          plugins: [...plugins],
          build: {
            lib: { entry: config.entries, formats: ['es'] },
            ssr: true,
            ssrEmitAssets: true,
            target: 'node24',
            sourcemap: true,
            outDir: resolve('./dist'),
            minify: true,
            emptyOutDir: true,
            rolldownOptions: {
              platform: 'node',
              external: (id) => {
                if (neemataConfig.externalDependencies === 'all') return true
                if (
                  isBuiltin(id) ||
                  id.includes('nmtjs/src/vite/servers') ||
                  id.includes('nmtjs/src/vite/runners')
                )
                  return true

                if (neemataConfig.externalDependencies === 'prod') {
                  const prodDeps = Object.keys(packageJson.dependencies ?? {})
                  if (prodDeps.includes(id)) return true
                }

                if (Array.isArray(neemataConfig.externalDependencies)) {
                  for (const dep of neemataConfig.externalDependencies) {
                    if (typeof dep === 'string' && dep === id) return true
                    if (dep instanceof RegExp && dep.test(id)) return true
                  }
                }

                return false
              },
              transform: {
                define: {
                  __VITE_CONFIG__: '""',
                  __APPLICATIONS_CONFIG__: JSON.stringify(
                    JSON.stringify(
                      Object.fromEntries(
                        Object.entries(configOptions.applicationImports).map(
                          ([appName, { type }]) => [
                            appName,
                            { type, specifier: `./application.${appName}.js` },
                          ],
                        ),
                      ),
                    ),
                  ),
                },
              },
              output: {
                entryFileNames: '[name].js',
                chunkFileNames: '[name]-[hash].js',
                assetFileNames: '[name][extname]',
              },
            },
            chunkSizeWarningLimit: 10_000,
          },
        } satisfies UserConfig,
        neemataConfig.vite,
      ),
    )
  }
  return { build }
}
