import { access } from 'node:fs/promises'
import { isBuiltin, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { UserConfig } from 'vite'
import { defineCommand, runMain } from 'citty'
import { mergeConfig, build as viteBuild } from 'vite'

import type {
  NeemApplicationConfig,
  NeemApplicationsConfigRegistry,
  NeemConfig,
  NeemServerConfig,
} from './runtime/config.ts'
import type { PluginBuildEntrypoint } from './runtime/plugins.ts'
import {
  isApplicationConfig,
  isNeemConfig,
  isServerConfig,
} from './runtime/config.ts'
import {
  createBuildRuntimeModuleSource,
  createBuiltApplicationConfig,
  createBuiltPluginDescriptor,
  createSourceRuntimeModuleSource,
  neemRuntimeModuleId,
  neemRuntimeModuleUrl,
} from './runtime-module.ts'
import { createRuntimeModulePlugin, plugins } from './vite/plugins.ts'

type LoadedServerRuntimeConfig = {
  serverConfig: NeemServerConfig
  applicationsConfigRegistry: NeemApplicationsConfigRegistry
}

type LoadedRuntimeInputs = LoadedServerRuntimeConfig & {
  neemConfig: NeemConfig
  workerPath: string
}

const hostRuntimeExternalPatterns = [
  'vite',
  '/packages/neem/src/vite/',
  '/packages/neem/dist/vite/',
] as const

const DEFAULT_NEEM_CONFIG_FILES = [
  'neem.config.ts',
  'neem.config.js',
  'neem.config.mjs',
] as const

function resolveDefaultThreadEntrypoint(): string {
  const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
  return fileURLToPath(new URL(`./entrypoints/thread${ext}`, import.meta.url))
}

function resolveDefaultMainEntrypoint(): string {
  const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
  return fileURLToPath(new URL(`./entrypoints/main${ext}`, import.meta.url))
}

function resolveDefaultWorkerEntrypoint(): string {
  const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
  return fileURLToPath(new URL(`./entrypoints/worker${ext}`, import.meta.url))
}

async function resolveNeemConfigPath(
  configPathArg: unknown,
): Promise<string | undefined> {
  if (configPathArg) {
    return resolve(String(configPathArg))
  }

  for (const candidate of DEFAULT_NEEM_CONFIG_FILES) {
    const candidatePath = resolve(candidate)

    try {
      await access(candidatePath)
      return candidatePath
    } catch {}
  }

  return undefined
}

async function loadNeemConfig(
  configPathArg: unknown,
): Promise<NeemConfig | null> {
  const configPath = await resolveNeemConfigPath(configPathArg)
  if (!configPath) return null

  const loadedConfig = await import(
    /* @vite-ignore */
    pathToFileURL(configPath).href
  ).then((m) => m.default)

  if (!isNeemConfig(loadedConfig)) {
    throw new Error(
      'Invalid Neem config. Ensure module default-export is defineConfig(...) result.',
    )
  }

  return loadedConfig
}

async function loadServerConfig(
  serverPathArg: unknown,
): Promise<NeemServerConfig> {
  const serverPath = pathToFileURL(resolve(String(serverPathArg))).href

  const serverConfig = await import(
    /* @vite-ignore */
    serverPath
  ).then((m) => m.default)

  if (!isServerConfig(serverConfig)) {
    throw new Error(
      'Invalid server config. Ensure module default-export is defineServer(...) result.',
    )
  }

  return serverConfig
}

async function resolveRuntimeInputs(args: {
  config?: unknown
  worker?: unknown
}): Promise<LoadedRuntimeInputs> {
  const neemConfig = await loadNeemConfig(args.config)

  if (!neemConfig) {
    throw new Error(
      'Provide --config or place neem.config.ts/js in the current working directory',
    )
  }

  const loaded = {
    neemConfig,
    serverConfig: await loadServerConfig(neemConfig.server),
    applicationsConfigRegistry: neemConfig.applications,
  }

  const workerPath = args.worker
    ? resolve(String(args.worker))
    : neemConfig?.worker
      ? resolve(neemConfig.worker)
      : resolveDefaultThreadEntrypoint()

  return { ...loaded, workerPath }
}

async function loadApplicationConfig(
  applicationName: string,
  configPathArg: string,
): Promise<NeemApplicationConfig> {
  const configPath = pathToFileURL(resolve(configPathArg)).href

  const applicationConfig = await import(
    /* @vite-ignore */
    configPath
  ).then((m) => m.default)

  if (!isApplicationConfig(applicationConfig)) {
    throw new Error(
      `Invalid application config for [${applicationName}]. Ensure module default-export is defineApplicationConfig(...) result.`,
    )
  }

  return applicationConfig
}

async function loadApplicationsConfig(
  applicationNames: string[],
  applicationsConfigRegistry: NeemApplicationsConfigRegistry,
): Promise<Record<string, NeemApplicationConfig>> {
  const entries = await Promise.all(
    applicationNames.map(async (applicationName) => {
      const configPath = applicationsConfigRegistry[applicationName]
      if (!configPath) {
        throw new Error(
          `Application [${applicationName}] is missing a config path in applications config registry`,
        )
      }

      return [
        applicationName,
        await loadApplicationConfig(applicationName, configPath),
      ] as const
    }),
  )

  return Object.fromEntries(entries)
}

async function runServer(
  mode: 'development' | 'production',
  args: { config?: unknown; worker?: unknown },
) {
  const { neemConfig, serverConfig, applicationsConfigRegistry, workerPath } =
    await resolveRuntimeInputs(args)
  const applicationNames = Object.keys(serverConfig.applications)

  await loadApplicationsConfig(applicationNames, applicationsConfigRegistry)

  registerSourceRuntimeHooks({
    mode,
    workerPath,
    serverConfigPath: resolve(neemConfig.server),
    applicationConfigPaths: Object.fromEntries(
      applicationNames.map((applicationName) => {
        const configPath = applicationsConfigRegistry[applicationName]
        if (!configPath) {
          throw new Error(
            `Application [${applicationName}] is missing a config path in applications config registry`,
          )
        }

        return [applicationName, resolve(configPath)]
      }),
    ),
  })

  const mainModule = (await import(
    /* @vite-ignore */
    pathToFileURL(resolveDefaultMainEntrypoint()).href
  )) as {
    run: (options?: { setupProcessHandlers?: boolean }) => Promise<unknown>
  }

  await mainModule.run({ setupProcessHandlers: true })
}

function registerSourceRuntimeHooks(options: {
  mode: 'development' | 'production'
  workerPath: string
  serverConfigPath: string
  applicationConfigPaths: Record<string, string>
}) {
  const runtimeModuleSource = createSourceRuntimeModuleSource(options)

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === neemRuntimeModuleId) {
        return {
          url: neemRuntimeModuleUrl,
          format: 'module',
          shortCircuit: true,
        }
      }

      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === neemRuntimeModuleUrl) {
        return {
          format: 'module',
          source: runtimeModuleSource,
          shortCircuit: true,
        }
      }

      return nextLoad(url, context)
    },
  })
}

async function runBuild(args: { config?: unknown; outDir: unknown }) {
  const { neemConfig, serverConfig, applicationsConfigRegistry } =
    await resolveRuntimeInputs(args)
  const applicationNames = Object.keys(serverConfig.applications)
  const applicationsConfig = await loadApplicationsConfig(
    applicationNames,
    applicationsConfigRegistry,
  )

  const outDirRoot = resolve(String(args.outDir))
  const serverOutDir = resolve(outDirRoot, 'server')

  const appBuilds = applicationNames.map(async (applicationName) => {
    const application = applicationsConfig[applicationName]
    if (!application?.entrypoint) {
      throw new Error(
        `Application [${applicationName}] is missing an entrypoint in its application config`,
      )
    }

    await viteBuild(
      mergeConfig(
        {
          appType: 'custom',
          mode: 'production',
          plugins: [...plugins],
          build: {
            lib: { entry: application.entrypoint, formats: ['es'] },
            ssr: true,
            ssrEmitAssets: true,
            target: 'node24',
            sourcemap: true,
            outDir: resolve(outDirRoot, 'applications', applicationName),
            emptyOutDir: true,
            emitAssets: true,
            minify: true,
            rolldownOptions: {
              platform: 'node',
              output: {
                entryFileNames: '[name].js',
                chunkFileNames: '[name]-[hash].js',
                assetFileNames: '[name][extname]',
              },
            },
          },
        } satisfies UserConfig,
        application.viteConfig ?? {},
      ),
    )
  })

  const pluginBuilds = (serverConfig.plugins ?? []).map(
    async (plugin, instanceId) => {
      const resolver = plugin.build?.entrypoints
      if (!resolver) return

      const entrypoints = await resolver({ mode: 'production' })

      for (const entrypoint of entrypoints) {
        await buildPluginEntrypoint(
          outDirRoot,
          plugin.name,
          instanceId,
          entrypoint,
        )
      }
    },
  )

  await Promise.all([...appBuilds, ...pluginBuilds])

  const pluginDescriptors = Object.fromEntries(
    await Promise.all(
      (serverConfig.plugins ?? []).map(async (plugin, instanceId) => {
        const entrypoints = await plugin.build?.entrypoints?.({
          mode: 'production',
        })

        return [
          `${instanceId}-${plugin.name}`,
          createBuiltPluginDescriptor(
            serverOutDir,
            outDirRoot,
            plugin.name,
            instanceId,
            entrypoints ?? [],
          ),
        ] as const
      }),
    ),
  )

  const runtimeModuleSource = createBuildRuntimeModuleSource({
    serverConfigPath: resolve(neemConfig.server),
    workerPath: './thread.js',
    applicationsConfig: Object.fromEntries(
      applicationNames.map((applicationName) => [
        applicationName,
        createBuiltApplicationConfig(
          serverOutDir,
          outDirRoot,
          applicationName,
          applicationsConfig[applicationName]!.entrypoint,
        ),
      ]),
    ),
    plugins: pluginDescriptors,
  })

  await viteBuild({
    appType: 'custom',
    mode: 'production',
    plugins: [...plugins, createRuntimeModulePlugin(runtimeModuleSource)],
    build: {
      lib: {
        entry: {
          main: resolveDefaultMainEntrypoint(),
          thread: resolveDefaultThreadEntrypoint(),
          worker: resolveDefaultWorkerEntrypoint(),
        },
        formats: ['es'],
      },
      ssr: true,
      ssrEmitAssets: true,
      target: 'node24',
      sourcemap: true,
      outDir: serverOutDir,
      emptyOutDir: true,
      emitAssets: true,
      minify: true,
      rolldownOptions: {
        platform: 'node',
        external: (id) =>
          isBuiltin(id) || id.startsWith('node:') || isHostRuntimeExternal(id),
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name]-[hash].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  } satisfies UserConfig)
}

async function buildPluginEntrypoint(
  outDirRoot: string,
  pluginName: string,
  instanceId: number,
  entrypoint: PluginBuildEntrypoint,
) {
  const baseConfig = {
    appType: 'custom' as const,
    mode: 'production' as const,
    plugins: [...plugins],
    build: {
      ssr: entrypoint.source,
      outDir: resolve(
        outDirRoot,
        'plugins',
        `${instanceId}-${pluginName}`,
        entrypoint.id,
      ),
      emptyOutDir: false,
    },
  }

  await viteBuild(
    entrypoint.vite ? mergeConfig(baseConfig, entrypoint.vite) : baseConfig,
  )
}

function isHostRuntimeExternal(id: string): boolean {
  return hostRuntimeExternalPatterns.some((pattern) => {
    if (pattern === 'vite') {
      return id === pattern || id.startsWith(`${pattern}/`)
    }

    return id.includes(pattern)
  })
}

const mainCommand = defineCommand({
  meta: { description: 'Neem CLI' },
  subCommands: {
    dev: defineCommand({
      meta: {
        description: 'Start neem application server in development mode',
      },
      args: {
        config: {
          type: 'string',
          required: false,
          description:
            'Path to neem.config.ts/js (defaults to auto-discovery in current working directory)',
        },
        worker: {
          type: 'string',
          required: false,
          description:
            'Path to worker thread entrypoint (defaults to neem internal thread entrypoint)',
        },
      },
      async run(ctx) {
        await runServer('development', {
          config: ctx.args.config,
          worker: ctx.args.worker,
        })
      },
    }),
    start: defineCommand({
      meta: {
        description:
          'Start neem application server in production mode using Vite server runtime (no HMR)',
      },
      args: {
        config: {
          type: 'string',
          required: false,
          description:
            'Path to neem.config.ts/js (defaults to auto-discovery in current working directory)',
        },
        worker: {
          type: 'string',
          required: false,
          description:
            'Path to worker thread entrypoint (defaults to neem internal thread entrypoint)',
        },
      },
      async run(ctx) {
        await runServer('production', {
          config: ctx.args.config,
          worker: ctx.args.worker,
        })
      },
    }),
    build: defineCommand({
      meta: {
        description:
          'Build applications and plugin entrypoints with Vite in production mode',
      },
      args: {
        config: {
          type: 'string',
          required: false,
          description:
            'Path to neem.config.ts/js (defaults to auto-discovery in current working directory)',
        },
        outDir: {
          type: 'string',
          required: false,
          default: '.neem/build',
          description: 'Output directory for built artifacts',
        },
      },
      async run(ctx) {
        await runBuild({ config: ctx.args.config, outDir: ctx.args.outDir })
      },
    }),
  },
})

runMain(mainCommand)
