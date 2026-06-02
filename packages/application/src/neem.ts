import { basename, dirname, join } from 'node:path'

import type {
  AnyApplicationHostDefinition,
  ApplicationHost,
  ApplicationHostDefinition,
  ApplicationHostTransportConfig,
  TransportOptionsOf,
} from './host.ts'
import type {
  InferNeemRuntimeThreadOptions,
  NeemEntryInput,
  NeemRolldownOptions,
  NeemRuntime,
  NeemRuntimeConfig,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'
import { defineRuntime, defineRuntimeWorker } from '@nmtjs/neem'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationTransport } from './config.ts'
import { createApplicationHost } from './host.ts'

export type NeemataRuntimeTransportOptions<
  Transports extends Record<string, ApplicationTransport>,
> = {
  [K in keyof Transports]: TransportOptionsOf<Transports[K]>
}

export type NeemataRuntimeThreadOptions<
  THost extends ApplicationHostDefinition,
> =
  THost extends ApplicationHostDefinition<any, infer Transports>
    ? NeemataRuntimeTransportOptions<Transports>
    : never

export type NeemataRuntimeContext<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = NeemRuntimeWorkerContext<NeemataRuntimeThreadOptions<THost>, THost>

export type NeemataWorker<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = NeemRuntimeWorker<NeemataRuntimeThreadOptions<THost>, THost>

export type NeemataRuntimeConfig<TEntry extends NeemataWorker = NeemataWorker> =
  NeemRuntimeConfig<TEntry>

export class NeemataApplicationRuntime<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> implements NeemRuntime
{
  readonly host: ApplicationHost<THost['transports']>

  constructor(readonly ctx: NeemataRuntimeContext<THost>) {
    this.host = createApplicationHost(ctx.definition.application, {
      name: ctx.name,
      logger: ctx.logger,
      formats: new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
      transports: createHostTransportConfig(
        ctx.definition.transports,
        ctx.data,
      ),
    })
  }

  async start() {
    return this.host.start()
  }

  async stop() {
    return this.host.stop()
  }
}

export function defineNeemataRuntime<
  const TEntry extends NeemataWorker = NeemataWorker,
>(config: {
  application: NeemEntryInput
  threads: readonly InferNeemRuntimeThreadOptions<TEntry>[]
}): NeemRuntimeConfig<TEntry> {
  return defineRuntime<TEntry>({
    worker: {
      entry: config.application,
      build: { rolldown: { plugins: [createUwsNativeAddonPlugin()] } },
    },
    threads: config.threads,
  })
}

export function defineNeemataWorker<
  const THost extends ApplicationHostDefinition,
>(host: THost): NeemataWorker<THost> {
  return defineRuntimeWorker<NeemataRuntimeThreadOptions<THost>, THost>({
    definition: host,
    createRuntime(ctx) {
      return new NeemataApplicationRuntime(ctx)
    },
  })
}

function createHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
>(
  transports: Transports,
  options: NeemataRuntimeTransportOptions<Transports>,
): ApplicationHostTransportConfig<Transports> {
  const config = {} as ApplicationHostTransportConfig<Transports>

  for (const key in transports) {
    config[key] = { transport: transports[key], options: options[key] }
  }

  return config
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
