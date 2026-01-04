import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

import { build as viteBuild } from 'vite'

import type { NeemataConfig } from '../config.ts'
import type { ViteConfigOptions } from './config.ts'
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

    // technically it's possible to do the same with rolldown directly,
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
        target: 'node24',
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
              id.includes('nmtjs/src/vite/servers') ||
              id.includes('nmtjs/src/vite/runners') ||
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
            chunkFileNames: 'chunks/[name]-[hash].js',
            minify: neemataConfig.build.minify,
          },
        },
        chunkSizeWarningLimit: 10_000,
      },
    })
  }
  return { build }
}
