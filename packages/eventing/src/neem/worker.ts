import type { NeemRuntime, NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { EventingRuntimeConfig, EventingWorkerData } from './runtime.ts'
import { EventingRunner } from '../core/runner.ts'

export type EventingWorkerConfig = Pick<
  EventingRuntimeConfig,
  'adapter' | 'consumers'
>

export function defineEventingWorker(config: EventingWorkerConfig) {
  return defineRuntimeWorker<EventingWorkerData, EventingWorkerConfig>({
    definition: config,
    createRuntime(ctx) {
      return new EventingRuntime(ctx, ctx.definition)
    },
  })
}

class EventingRuntime implements NeemRuntime {
  protected readonly abortController = new AbortController()
  protected runner?: EventingRunner

  constructor(
    protected readonly ctx: NeemRuntimeWorkerContext<
      EventingWorkerData,
      EventingWorkerConfig
    >,
    protected readonly config: EventingWorkerConfig,
  ) {}

  async start() {
    const adapter = await this.config.adapter()
    this.runner = new EventingRunner({ logger: this.ctx.logger }, { adapter })
    await this.runner.start({
      consumers: this.config.consumers,
      consumerIndexes: this.ctx.data.consumerIndexes,
      consumerId: this.ctx.name,
      signal: this.abortController.signal,
    })
    return undefined
  }

  async stop() {
    this.abortController.abort()
    await this.runner?.dispose()
    this.runner = undefined
  }
}
