import type { AnyFilter, AnyRouter, ApiOptions } from '@nmtjs/api'
import type { ErrorClass } from '@nmtjs/common'
import type { AnyHook, LoggingOptions } from '@nmtjs/core'
import type {
  AnyTransportPlugin,
  ProtocolOptions,
} from '@nmtjs/protocol/server'
import { createConsolePrettyDestination } from '@nmtjs/core'

import type { LifecycleHooks } from '../../core/src/hooks/lifecycle-hooks.ts'
import type { AnyJob } from '../../runtime/src/jobs/job.ts'
import type { AnyCommand, CommandsOptions } from './commands.ts'
import type { ApplicationType } from './enums.ts'
import type { AnyApplicationPlugin } from './plugins.ts'
import type { PubSubOptions } from './pubsub.ts'
import { kApplicationConfig } from './constants.ts'

export type ApplicationConfigTransport = {
  transport: AnyTransportPlugin
  options?: any
}

export type ApplicationConfigPlugin = {
  plugin: AnyApplicationPlugin
  options?: any
}

export type ApplicationConfigCommands = {
  options: CommandsOptions
  commands: AnyCommand[]
}

export type ApplicationConfigFilter = [ErrorClass, AnyFilter]

export type AnyApplicationConfig = ApplicationConfig<
  AnyRouter | undefined
  // ApplicationConfigTransport[],
  // ApplicationConfigPlugin[]
>

export interface ApplicationConfig<
  Router extends AnyRouter | undefined = AnyRouter | undefined,
  // Transports extends
  //   ApplicationConfigTransport[] = ApplicationConfigTransport[],
  // Plugins extends ApplicationConfigPlugin[] = ApplicationConfigPlugin[],
> {
  [kApplicationConfig]: any
  router: Router
  api: ApiOptions
  // pubsub: PubSubOptions
  logging: LoggingOptions
  // protocol: ProtocolOptions
  // transports: Transports
  // plugins: Plugins
  filters: ApplicationConfigFilter[]
  hooks: AnyHook[]
  lifecycleHooks: LifecycleHooks['_']['config']
}

export type ApplicationConfigFactory<
  T extends ApplicationConfig = ApplicationConfig,
> = (type: ApplicationType, workerData?: any) => Partial<T>

export function defineApplication<T extends ApplicationConfigFactory>(
  factory: T,
) {
  return factory
}

export function resolveApplicationConfig<
  F extends ApplicationConfigFactory,
  // T extends F extends ApplicationConfigFactory<
  //   infer Config extends ApplicationConfig
  // >
  //   ? ApplicationConfig<
  //       Config['router'],
  //       Config['transports'],
  //       Config['plugins']
  //     >
  //   : never,
>(factory: F, type: ApplicationType, workerData?: any): T {
  const options = factory(type, workerData)
  const {
    router,
    api = { timeout: 60000 } as T['api'],
    // protocol = { formats: [] } as T['protocol'],
    // jobs = [] as T['jobs'],
    // plugins = [] as T['plugins'],
    // transports = [] as T['transports'],
    // commands = { options: { timeout: 120_000 }, commands: [] } as T['commands'],
    filters = [] as T['filters'],
    hooks = [] as T['hooks'],
    logging = {
      destinations: [createConsolePrettyDestination('info')],
      pinoOptions: { level: 'info' },
    } as T['logging'],
    pubsub = {} as T['pubsub'],
    lifecycleHooks = {},
  } = options

  return Object.freeze({
    [kApplicationConfig]: true,
    api,
    // protocol,
    router,
    // commands,
    // jobs,
    // plugins,
    // transports,
    filters,
    logging,
    hooks,
    pubsub,
    lifecycleHooks,
  } satisfies AnyApplicationConfig) as T
}

export function isApplicationConfig(value: any): value is ApplicationConfig {
  return Boolean(value?.[kApplicationConfig])
}
