import type {
  NeemEntryLoader,
  NeemRuntime,
  NeemRuntimeConfig,
  NeemWorker,
  NeemWorkerRuntimeContext,
} from '@nmtjs/neem'
import { defineRuntimeConfig, defineWorker } from '@nmtjs/neem'

import type { NeemataApplication, NeemataAppTransportOptions } from './app.ts'
import type { AnyApplicationConfig } from './config.ts'
import { createApp } from './app.ts'

export type NeemataRuntimeThreadOptions<
  TApplication extends AnyApplicationConfig,
> = NeemataAppTransportOptions<TApplication>

export type NeemataRuntimeContext<
  TApplication extends AnyApplicationConfig = AnyApplicationConfig,
> = NeemWorkerRuntimeContext<
  NeemataRuntimeThreadOptions<TApplication>,
  TApplication
>

export type NeemataWorker<
  TApplication extends AnyApplicationConfig = AnyApplicationConfig,
> = NeemWorker<NeemataRuntimeThreadOptions<TApplication>, TApplication>

export type NeemataRuntimeConfig<
  TApplication extends AnyApplicationConfig = AnyApplicationConfig,
> = NeemRuntimeConfig<NeemataWorker<TApplication>>

export class NeemataApplicationRuntime<
  TApplication extends AnyApplicationConfig = AnyApplicationConfig,
> implements NeemRuntime
{
  readonly application: NeemataApplication<TApplication>

  constructor(readonly ctx: NeemataRuntimeContext<TApplication>) {
    this.application = createApp(ctx.definition, {
      logger: ctx.logger,
      mode: ctx.mode,
      transports: ctx.data,
    })
  }

  async start() {
    return this.application.start()
  }

  async stop() {
    return this.application.stop()
  }
}

export function defineNeemataRuntime<
  const TApplication extends AnyApplicationConfig,
>(config: {
  entry: NeemEntryLoader<NeemataWorker<TApplication>>
  build?: NeemRuntimeConfig<NeemataWorker<TApplication>>['build']
  threads: Array<NeemataRuntimeThreadOptions<TApplication>>
}): NeemataRuntimeConfig<TApplication> {
  return defineRuntimeConfig(config)
}

export function defineNeemataWorker<
  const TApplication extends AnyApplicationConfig,
>(application: TApplication): NeemataWorker<TApplication> {
  return defineWorker<NeemataRuntimeThreadOptions<TApplication>, TApplication>({
    definition: application,
    createRuntime(ctx) {
      return new NeemataApplicationRuntime(ctx)
    },
  })
}
