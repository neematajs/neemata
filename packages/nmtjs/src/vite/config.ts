import { fileURLToPath } from 'node:url'

export type ViteConfigOptions = {
  applicationImports: Record<string, { path: string; specifier: string }>
  serverEntryPath: string
  entrypointMainPath: string
  entrypointWorkerPath: string
  entrypointThreadPath: string
  // entrypointCLIPath: string
  configPath: string
}

const ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
export const baseViteConfigOptions = {
  entrypointMainPath: fileURLToPath(
    import.meta.resolve(`../entrypoints/main${ext}`),
  ),
  entrypointWorkerPath: fileURLToPath(
    import.meta.resolve(`../entrypoints/worker${ext}`),
  ),
  entrypointThreadPath: fileURLToPath(
    import.meta.resolve(`../entrypoints/thread${ext}`),
  ),
  // entrypointCLIPath: fileURLToPath(import.meta.resolve('../entrypoints/cli')),
} satisfies Partial<ViteConfigOptions>

export function createConfig(options: ViteConfigOptions) {
  const alias = { '#server': options.serverEntryPath }
  const entries = {
    server: options.serverEntryPath,
    main: options.entrypointMainPath,
    worker: options.entrypointWorkerPath,
    thread: options.entrypointThreadPath,
  }

  for (const [name, { path }] of Object.entries(options.applicationImports)) {
    entries[`application.${name}`] = path
  }

  return { alias, entries }
}
