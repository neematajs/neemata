import type { AnyRouter, Api } from '@nmtjs/api'
import type {
  Container,
  Hooks,
  LazyInjectable,
  Logger,
  Plugin,
} from '@nmtjs/core'
import type { Protocol, ProtocolFormats } from '@nmtjs/protocol/server'
import { createPlugin } from '@nmtjs/core'

import type { ApplicationType } from './enums.ts'
import type { LifecycleHooks } from './lifecycle-hooks.ts'
import type { ApplicationRegistry } from './registry.ts'

export interface ApplicationPluginContext {
  readonly type: ApplicationType
  readonly api: Api
  readonly format: ProtocolFormats
  readonly container: Container
  readonly logger: Logger
  readonly registry: ApplicationRegistry
  readonly hooks: Hooks
  readonly protocol: Protocol
  readonly lifecycleHooks: LifecycleHooks
}

export interface ApplicationPluginType<
  Router extends AnyRouter | undefined = AnyRouter | undefined,
> {
  hooks?: LifecycleHooks['_']['config']
  provide?: Array<[LazyInjectable<any>, any]>
  router?: Router
}

export type AnyApplicationPlugin = ApplicationPlugin<any, any>
export interface ApplicationPlugin<
  Options = unknown,
  Router extends AnyRouter | undefined = AnyRouter | undefined,
> extends Plugin<
    ApplicationPluginType<Router> | undefined,
    Options,
    ApplicationPluginContext
  > {}

export function createApplicationPlugin<
  Options = unknown,
  Router extends AnyRouter | undefined = AnyRouter | undefined,
>(name: string, factory: ApplicationPlugin<Options, Router>['factory']) {
  return createPlugin<
    ApplicationPluginType<Router> | undefined,
    Options,
    ApplicationPluginContext
  >(name, factory)
}
