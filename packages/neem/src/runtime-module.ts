import { basename, extname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  NeemApplicationConfig,
  NeemServerConfig,
} from './runtime/config.ts'
import type { PluginBuildEntrypoint } from './runtime/plugins.ts'

export const neemRuntimeModuleId = '#neem/runtime'
export const neemRuntimeModuleUrl = 'neem:runtime'

export interface NeemRuntimePluginEntrypointDescriptor {
  path: string
  target: PluginBuildEntrypoint['target']
}

export interface NeemRuntimePluginDescriptor {
  entrypoints: Record<string, NeemRuntimePluginEntrypointDescriptor>
}

export interface NeemRuntimeDescriptor {
  mode: 'development' | 'production'
  moduleLoader: 'runner' | 'native'
  workerPath: string
  serverConfig: NeemServerConfig
  applicationsConfig: Record<string, NeemApplicationConfig>
  plugins: Record<string, NeemRuntimePluginDescriptor>
}

export function createSourceRuntimeModuleSource(options: {
  mode: NeemRuntimeDescriptor['mode']
  workerPath: string
  serverConfigPath: string
  applicationConfigPaths: Record<string, string>
}): string {
  const applicationEntries = Object.entries(options.applicationConfigPaths)
  const imports = [
    `import serverConfig from ${JSON.stringify(pathToFileURL(options.serverConfigPath).href)}`,
    ...applicationEntries.map(
      ([applicationName, applicationConfigPath], index) =>
        `import applicationConfig${index} from ${JSON.stringify(pathToFileURL(applicationConfigPath).href)} // ${applicationName}`,
    ),
  ]

  const applicationsConfig = applicationEntries.length
    ? `{
${applicationEntries
  .map(
    ([applicationName], index) =>
      `  ${JSON.stringify(applicationName)}: applicationConfig${index}`,
  )
  .join(',\n')}
}`
    : '{}'

  return `${imports.join('\n')}

export default {
  mode: ${JSON.stringify(options.mode)},
  moduleLoader: 'runner',
  workerPath: ${JSON.stringify(options.workerPath)},
  serverConfig,
  applicationsConfig: ${applicationsConfig},
  plugins: {},
}
`
}

export function createBuildRuntimeModuleSource(options: {
  serverConfigPath: string
  workerPath: string
  applicationsConfig: Record<string, NeemApplicationConfig>
  plugins: Record<string, NeemRuntimePluginDescriptor>
}): string {
  return `import serverConfig from ${JSON.stringify(pathToFileURL(options.serverConfigPath).href)}

export default {
  mode: 'production',
  moduleLoader: 'native',
  workerPath: ${JSON.stringify(options.workerPath)},
  serverConfig,
  applicationsConfig: ${JSON.stringify(options.applicationsConfig, null, 2)},
  plugins: ${JSON.stringify(options.plugins, null, 2)},
}
`
}

export function createBuiltApplicationConfig(
  serverOutDir: string,
  outDirRoot: string,
  applicationName: string,
  entrypoint: string,
): NeemApplicationConfig {
  return {
    entrypoint: normalizePath(
      relative(
        serverOutDir,
        createBuiltArtifactPath(
          outDirRoot,
          ['applications', applicationName],
          entrypoint,
        ),
      ),
    ),
  }
}

export function createBuiltPluginDescriptor(
  serverOutDir: string,
  outDirRoot: string,
  pluginName: string,
  instanceId: number,
  entrypoints: PluginBuildEntrypoint[],
): NeemRuntimePluginDescriptor {
  return {
    entrypoints: Object.fromEntries(
      entrypoints.map((entrypoint) => [
        entrypoint.id,
        {
          target: entrypoint.target,
          path: normalizePath(
            relative(
              serverOutDir,
              createBuiltArtifactPath(
                outDirRoot,
                ['plugins', `${instanceId}-${pluginName}`, entrypoint.id],
                entrypoint.source,
              ),
            ),
          ),
        },
      ]),
    ),
  }
}

function createBuiltArtifactPath(
  outDirRoot: string,
  segments: string[],
  sourceEntrypoint: string,
): string {
  return `${outDirRoot}/${segments.join('/')}/${basename(sourceEntrypoint, extname(sourceEntrypoint))}.js`
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}
