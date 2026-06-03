import type { NeemRuntime, NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { EventingConsumer } from '../core/adapter.ts'
import type { EventingRuntimeConfig, EventingWorkerData } from './runtime.ts'
import { handleEventingConsumerMessage } from '../core/consumer.ts'

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
  protected readonly consumers: EventingConsumer[] = []
  protected adapter?: Awaited<ReturnType<EventingRuntimeConfig['adapter']>>

  constructor(
    protected readonly ctx: NeemRuntimeWorkerContext<
      EventingWorkerData,
      EventingWorkerConfig
    >,
    protected readonly config: EventingWorkerConfig,
  ) {}

  async start() {
    const adapter = await this.config.adapter()
    this.adapter = adapter
    await adapter.initialize()

    const definitions = await this.config.consumers()
    for (const index of this.ctx.data.consumerIndexes) {
      const definition = definitions[index]!
      const consumer = await adapter.consume(
        {
          topics: [definition.event.topic],
          groupId: definition.groupId,
          consumerId: definition.consumerId ?? this.ctx.name,
          from: definition.from,
          recoverPending: definition.recoverPending,
          deadLetter: definition.deadLetter,
          signal: this.abortController.signal,
        },
        async (message) => {
          if (message.name !== definition.event.name) return
          await handleEventingConsumerMessage(
            definition,
            { logger: this.ctx.logger },
            message,
          )
        },
      )
      this.consumers.push(consumer)
      consumer.closed.catch((error) => {
        if (this.abortController.signal.aborted) return
        this.ctx.logger.error(
          { error, event: definition.event.name },
          'Eventing consumer failed',
        )
        queueMicrotask(() => {
          throw error
        })
      })
    }
    return undefined
  }

  async stop() {
    this.abortController.abort()
    await Promise.allSettled(this.consumers.map((consumer) => consumer.close()))
    this.consumers.length = 0
    await this.adapter?.dispose()
    this.adapter = undefined
  }
}
