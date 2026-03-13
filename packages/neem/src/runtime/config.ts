import type { UserConfig } from 'vite'

import type {
  ApplicationAdapter,
  ApplicationDefinition,
  Applications,
  NeemServerConfigInit,
  NeemServerProxyConfig,
} from '../types.ts'
import {
  kApplicationConfig,
  kApplicationDefinition,
  kNeemConfig,
  kServerConfig,
} from './constants.ts'

export interface NeemApplicationConfig {
  entrypoint: string
  viteConfig?: UserConfig
}

export type NeemApplicationsConfigRegistry = Record<string, string>

export interface NeemConfig {
  server: string
  applications: NeemApplicationsConfigRegistry
  worker?: string
}

export type ApplicationDefinitionWithMarker<
  TAdapter extends ApplicationAdapter = ApplicationAdapter,
> = ApplicationDefinition<TAdapter> & {
  readonly [kApplicationDefinition]: true
}

export type ApplicationConfigWithMarker = NeemApplicationConfig & {
  readonly [kApplicationConfig]: true
}

export type NeemConfigWithMarker = NeemConfig & { readonly [kNeemConfig]: true }

export interface NeemServerConfig<TApps extends Applications = Applications> {
  readonly [kServerConfig]: true
  logger?: NeemServerConfigInit<TApps>['logger']
  applications: NeemServerConfigInit<TApps>['applications']
  proxy?: NeemServerProxyConfig<TApps>
  plugins: NeemServerConfigInit<TApps>['plugins']
  deploymentId?: string
  metrics?: NeemServerConfigInit<TApps>['metrics']
}

export function defineApplication<
  TAdapter extends ApplicationAdapter,
>(options: {
  adapter: TAdapter
  commands?: ApplicationDefinition<TAdapter>['commands']
  definition: TAdapter extends ApplicationAdapter<
    string,
    infer TDefinition,
    any
  >
    ? TDefinition
    : never
}): ApplicationDefinitionWithMarker<TAdapter> {
  return Object.freeze({
    [kApplicationDefinition]: true,
    adapter: options.adapter,
    commands: options.commands ?? [],
    definition: options.definition,
  }) as ApplicationDefinitionWithMarker<TAdapter>
}

export function defineApplicationConfig(
  options: NeemApplicationConfig,
): ApplicationConfigWithMarker {
  return Object.freeze({
    [kApplicationConfig]: true,
    entrypoint: options.entrypoint,
    viteConfig: options.viteConfig,
  } as const) as ApplicationConfigWithMarker
}

export function defineServer<TApps extends Applications>(
  options: NeemServerConfigInit<TApps>,
): NeemServerConfig<TApps> {
  return Object.freeze({
    [kServerConfig]: true,
    logger: options.logger,
    applications: options.applications,
    proxy: options.proxy,
    plugins: options.plugins ?? [],
    deploymentId: options.deploymentId,
    metrics: options.metrics,
  } as const) as NeemServerConfig<TApps>
}

export function defineConfig(options: NeemConfig): NeemConfigWithMarker {
  return Object.freeze({
    [kNeemConfig]: true,
    server: options.server,
    applications: options.applications,
    worker: options.worker,
  } as const) as NeemConfigWithMarker
}

export function isApplicationConfig(
  value: unknown,
): value is ApplicationConfigWithMarker {
  return Boolean(
    value && typeof value === 'object' && kApplicationConfig in value,
  )
}

export function isNeemConfig(value: unknown): value is NeemConfigWithMarker {
  return Boolean(value && typeof value === 'object' && kNeemConfig in value)
}

export function isServerConfig(value: unknown): value is NeemServerConfig {
  return Boolean(value && typeof value === 'object' && kServerConfig in value)
}
