import type {
  Applications,
  NeemServerConfigInit,
  NeemServerProxyConfig,
} from '../types.ts'
import { kServerConfig } from '../constants.ts'

export interface NeemServerConfig<TApps extends Applications = Applications> {
  readonly [kServerConfig]: true
  logger?: NeemServerConfigInit<TApps>['logger']
  applications: NeemServerConfigInit<TApps>['applications']
  proxy?: NeemServerProxyConfig<TApps>
  commands: NeemServerConfigInit<TApps>['commands']
  plugins: NeemServerConfigInit<TApps>['plugins']
  deploymentId?: string
  metrics?: NeemServerConfigInit<TApps>['metrics']
}

export function defineServer<TApps extends Applications>(
  options: NeemServerConfigInit<TApps>,
): NeemServerConfig<TApps> {
  return Object.freeze({
    [kServerConfig]: true,
    logger: options.logger,
    applications: options.applications,
    proxy: options.proxy,
    commands: options.commands ?? [],
    plugins: options.plugins ?? [],
    deploymentId: options.deploymentId,
    metrics: options.metrics,
  } as const) as NeemServerConfig<TApps>
}

export function isServerConfig(value: unknown): value is NeemServerConfig {
  return Boolean(value && typeof value === 'object' && kServerConfig in value)
}
