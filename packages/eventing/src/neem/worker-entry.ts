import { pathToFileURL } from 'node:url'

import type { NeemRuntime, NeemWorkerRuntimeContext } from '@nmtjs/neem'
import { defineWorker } from '@nmtjs/neem'

import type { EventingConsumer } from '../core/adapter.ts'
import type { EventingConsumerDefinition } from '../core/consumer.ts'
import type { EventingRuntimeConfig } from './runtime.ts'
import { decodeEventingMessage } from '../core/consumer.ts'
import { eventingConfigArtifactId } from './runtime.ts'

export default defineWorker({
  definition: {},
  async createRuntime(ctx: NeemWorkerRuntimeContext<unknown, unknown>) {
    const artifact = ctx.artifacts.resolve(eventingConfigArtifactId)
    if (!artifact) {
      throw new Error(`Missing eventing artifact [${eventingConfigArtifactId}]`)
    }
    const module = (await import(pathToFileURL(artifact.file).href)) as {
      default: EventingRuntimeConfig
    }
    const config = module.default
    return new EventingRuntime(ctx, config)
  },
})

class EventingRuntime implements NeemRuntime {
  protected readonly abortController = new AbortController()
  protected readonly consumers: EventingConsumer[] = []
  protected adapter?: Awaited<ReturnType<EventingRuntimeConfig['adapter']>>

  constructor(
    protected readonly ctx: NeemWorkerRuntimeContext,
    protected readonly config: EventingRuntimeConfig,
  ) {}

  async start() {
    const adapter = await this.config.adapter()
    this.adapter = adapter
    await adapter.initialize()

    const definitions = await this.config.consumers()
    for (const definition of definitions) {
      const consumer = await adapter.consume(
        {
          topics: [definition.event.topic],
          groupId: definition.groupId,
          consumerId: definition.consumerId ?? this.ctx.name,
          from: definition.from,
          signal: this.abortController.signal,
        },
        async (message) => {
          if (message.name !== definition.event.name) return
          const event = decodeEventingMessage(definition.event, message)
          await runHandler(definition, this.ctx, event, message)
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

async function runHandler(
  definition: EventingConsumerDefinition,
  ctx: NeemWorkerRuntimeContext,
  event: unknown,
  message: unknown,
) {
  await definition.handle(
    { logger: ctx.logger },
    event as never,
    message as never,
  )
}
