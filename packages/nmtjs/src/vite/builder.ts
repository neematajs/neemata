import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

import { build as viteBuild } from 'vite'

import type { NeemataConfig } from '../config.ts'
import type { ViteConfigOptions } from './config.ts'
// import pkgJson from '../../package.json' with { type: 'json' }
import { createConfig } from './config.ts'
import { buildPlugins } from './plugins.ts'

export async function createBuilder(
  configOptions: ViteConfigOptions,
  neemataConfig: NeemataConfig,
) {
  const config = createConfig(configOptions)
  async function build(): Promise<any> {
    const packageJson = await import(resolve('./package.json'), {
      with: { type: 'json' },
    }).then((mod) => mod.default)

    // techinically it's possible to do the same with rolldown directly,
    // but vite handles a lot of things, like defines substitutions, etc.
    // also, since during dev the code is processed via vite anyway,
    // using vite for build as well ensures consistency between dev and prod
    return await viteBuild({
      appType: 'custom',
      clearScreen: false,
      resolve: { alias: config.alias },
      ssr: { noExternal: true },
      plugins: [...buildPlugins, ...neemataConfig.plugins],
      build: {
        lib: { entry: config.entries, formats: ['es'] },
        ssr: true,
        target: 'node20',
        sourcemap: true,
        outDir: resolve(neemataConfig.build.outDir),
        minify: neemataConfig.build.minify,
        emptyOutDir: true,
        rolldownOptions: {
          platform: 'node',
          external: (id) => {
            if (neemataConfig.externalDependencies === 'all') return true
            if (
              isBuiltin(id) ||
              id.includes('vite/runner') ||
              id.endsWith('.node')
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
                    Object.keys(configOptions.applicationImports).map(
                      (appName) => [appName, `./application.${appName}.js`],
                    ),
                  ),
                ),
              ),
              __dirname: 'new URL(".", import.meta.url).pathname',
              __filename: 'new URL(import.meta.url).pathname',
            },
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            advancedChunks: {
              groups: [
                {
                  name: 'ioredis',
                  test: /node_modules[\\/](@ioredis|ioredis|redis)/,
                  priority: 4,
                },
                {
                  name: 'bullmq',
                  test: /node_modules[\\/]bullmq/,
                  priority: 2,
                },
                { name: 'zod', test: /node_modules[\\/]zod/, priority: 2 },
                { name: 'pino', test: /node_modules[\\/]pino/, priority: 2 },
                {
                  name: '@nmtjs-runtime',
                  test: /node_modules[\\/](@nmtjs[\\/]runtime)/,
                  priority: 2,
                },
                {
                  name: '@nmtjs-common',
                  test: /node_modules[\\/]@nmtjs[\\/](?=[^runtime|nmtjs])/,
                  priority: 1,
                },
                { name: 'vendor', test: /node_modules/, priority: 0 },
              ],
            },
            minify: neemataConfig.build.minify,
          },
        },
        chunkSizeWarningLimit: 10_000,
      },
    })
  }
  return { build }
}
