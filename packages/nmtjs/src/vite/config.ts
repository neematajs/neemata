import { fileURLToPath } from 'node:url'

export type ViteConfigOptions = {
  applicationEntryPath: string
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
  return {
    alias: {
      '#application': options.applicationEntryPath,
      '#server': options.serverEntryPath,
      '#entrypoint.server': options.entrypointServerPath,
      '#entrypoint.worker': options.entrypointWorkerPath,
    },
    entries: {
      application: options.applicationEntryPath,
      server: options.serverEntryPath,
      main: options.entrypointServerPath,
      worker: options.entrypointWorkerPath,
      cli: options.entrypointCLIPath,
    },
  }
}
