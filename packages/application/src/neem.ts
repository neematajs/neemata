import type { NeemApp, NeemAppRuntimeContext, NeemRuntime } from '@nmtjs/neem'
import { defineApp } from '@nmtjs/neem'

import type { NeemataApplication, NeemataAppTransportOptions } from './app.ts'
import type { AnyApplicationConfig, ApplicationConfig } from './config.ts'
import { createApp } from './app.ts'

export type NeemataAppThreadOptions<
  TApplication extends ApplicationConfig<any, any>,
> = NeemataAppTransportOptions<TApplication>

export type NeemataAppRuntimeContext<
  TApplication extends ApplicationConfig<any, any> = AnyApplicationConfig,
> = NeemAppRuntimeContext<NeemataAppThreadOptions<TApplication>, TApplication>

export type NeemataApp<
  TApplication extends ApplicationConfig<any, any> = AnyApplicationConfig,
> = NeemApp<NeemataAppThreadOptions<TApplication>, TApplication>

export class NeemataApplicationRuntime<
  TApplication extends ApplicationConfig<any, any> = AnyApplicationConfig,
> implements NeemRuntime
{
  readonly application: NeemataApplication<TApplication>

  constructor(readonly ctx: NeemataAppRuntimeContext<TApplication>) {
    this.application = createApp(ctx.definition, {
      logger: ctx.logger,
      mode: ctx.mode,
      transports: ctx.threadOptions,
    })
  }

  async start() {
    return this.application.start()
  }

  async stop() {
    return this.application.stop()
  }
}

export function defineNeemataApp<
  const TApplication extends ApplicationConfig<any, any>,
>(application: TApplication): NeemataApp<TApplication> {
  return defineApp<NeemataAppThreadOptions<TApplication>, TApplication>({
    kind: 'neemata',
    definition: application,
    createRuntime(ctx) {
      return new NeemataApplicationRuntime(ctx)
    },
  })
}
