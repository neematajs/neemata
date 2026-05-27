import { basename, dirname, join } from 'node:path'

import type {
  InferNeemRuntimeThreadOptions,
  NeemEntryInput,
  NeemRolldownOptions,
  NeemRuntime,
  NeemRuntimeConfig,
  NeemRuntimeFactory,
  NeemWorker,
  NeemWorkerRuntimeContext,
} from '@nmtjs/neem'
import { defineRuntime, defineWorker } from '@nmtjs/neem'

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

export type NeemataRuntimeConfig<TEntry extends NeemataWorker = NeemataWorker> =
  NeemRuntimeConfig<TEntry>

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
  const TEntry extends NeemataWorker = NeemataWorker,
>(config: {
  application: NeemEntryInput<TEntry>
  threads: readonly InferNeemRuntimeThreadOptions<TEntry>[]
}): NeemRuntimeFactory {
  return defineRuntime<TEntry>({
    entry: config.application,
    threads: config.threads,
    build: { rolldown: { plugins: [createUwsNativeAddonPlugin()] } },
  })
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

type NeemataRolldownPluginContext = {
  fs: { readFile: (file: string) => Promise<Uint8Array> }
  emitFile: (emittedFile: {
    type: 'asset'
    name: string
    source: Uint8Array
  }) => string
  getFileName: (referenceId: string) => string
}

function createUwsNativeAddonPlugin(): NonNullable<
  NeemRolldownOptions['plugins']
> {
  return {
    name: 'neemata:uws-native-addon',
    async load(this: NeemataRolldownPluginContext, id: string) {
      if (!id.includes('uWebSockets.js/uws.js')) return null
      const nativeAddon = join(
        dirname(id),
        `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
      )
      const refId = this.emitFile({
        type: 'asset',
        name: basename(nativeAddon),
        source: await this.fs.readFile(nativeAddon),
      })

      return [
        'import { createRequire } from "node:module"',
        'const require = createRequire(import.meta.url)',
        `export default require(${JSON.stringify(`./${this.getFileName(refId)}`)})`,
      ].join('\n')
    },
  } as NonNullable<NeemRolldownOptions['plugins']>
}
