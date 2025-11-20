import { fileURLToPath } from 'node:url'

export type ViteConfigOptions = {
  applicationEntryPaths: Record<string, string>
  serverEntryPath: string
  entrypointServerPath: string
  entrypointWorkerPath: string
  entrypointCLIPath: string
  configPath: string
}

export const baseViteConfigOptions = {
  entrypointServerPath: fileURLToPath(
    import.meta.resolve('../entrypoints/server'),
  ),
  entrypointWorkerPath: fileURLToPath(
    import.meta.resolve('../entrypoints/worker'),
  ),
  entrypointCLIPath: fileURLToPath(import.meta.resolve('../entrypoints/cli')),
} satisfies Partial<ViteConfigOptions>

export function createConfig(options: ViteConfigOptions) {
  const alias = {
    '#server': options.serverEntryPath,
    '#entrypoint.server': options.entrypointServerPath,
    '#entrypoint.worker': options.entrypointWorkerPath,
  }
  const entries = {
    server: options.serverEntryPath,
    main: options.entrypointServerPath,
    worker: options.entrypointWorkerPath,
    cli: options.entrypointCLIPath,
  }

  for (const [name, path] of Object.entries(options.applicationEntryPaths)) {
    entries[`application.${name}`] = path
    alias[`#application.${name}`] = path
  }

  return { alias, entries }
}
