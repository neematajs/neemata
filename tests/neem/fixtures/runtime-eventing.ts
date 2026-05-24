import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessageHandler,
  EventingConsumer,
} from '@nmtjs/eventing'
import { consume, defineEvent, defineEventConsumers } from '@nmtjs/eventing'
import { defineEventing } from '@nmtjs/eventing/neem'
import { t } from '@nmtjs/type'

const userCreated = defineEvent({
  name: 'user.created',
  topic: 'users',
  key: t.string(),
  payload: t.object({ id: t.string() }),
})

class NoopEventingAdapter implements EventingAdapter {
  async initialize() {}
  async dispose() {}
  async produce() {}
  async consume(
    _options: EventingAdapterConsumeOptions,
    _handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer> {
    return { closed: new Promise(() => undefined), async close() {} }
  }
}

export default defineEventing({
  adapter: () => new NoopEventingAdapter(),
  consumers: defineEventConsumers([
    consume(userCreated, { groupId: 'users-projector', async handle() {} }),
  ]),
})
