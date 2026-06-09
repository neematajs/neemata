import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { Container } from '@nmtjs/core'
import { EventingRunner, implement } from '@nmtjs/eventing'
import { KafkaEventingAdapter } from '@nmtjs/eventing/kafka'
import { t } from '@nmtjs/type'
import { Admin } from '@platformatic/kafka'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createTestLogger,
  createTestName,
  kafkaBrokers,
  requireKafkaServiceEnv,
  waitFor,
} from './helpers.ts'

requireKafkaServiceEnv()

describe.skipIf(!kafkaBrokers?.length)(
  '@nmtjs/eventing Kafka integration',
  () => {
    const adapters: KafkaEventingAdapter[] = []
    const admins: Admin[] = []
    const topics = new Set<string>()

    afterEach(async () => {
      await Promise.allSettled(
        adapters.splice(0).map((adapter) => adapter.dispose()),
      )
      await Promise.allSettled(
        [...topics].map((topic) =>
          Promise.allSettled(
            admins.map((admin) => admin.deleteTopics({ topics: [topic] })),
          ),
        ),
      )
      topics.clear()
      await Promise.allSettled(
        admins.splice(0).map((admin) => closeAdmin(admin)),
      )
    })

    it('produces, consumes, and commits through a real Kafka broker', async () => {
      const topic = createTestName('events-kafka')
      const groupId = createTestName('group')
      const clientId = createTestName('client')
      topics.add(topic)
      const stream = SubscriptionContract({
        namespace: topic,
        params: t.object({ id: t.string() }),
        key: ({ id }) => id,
        events: {
          userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
        },
      })
      const event = stream.events.userCreated
      const admin = new Admin({
        clientId: `${clientId}-admin`,
        bootstrapBrokers: kafkaBrokers!,
      })
      admins.push(admin)
      await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 })

      const adapter = new KafkaEventingAdapter({
        clientId,
        bootstrapBrokers: kafkaBrokers!,
        producer: { autocreateTopics: true },
        consumer: { maxWaitTime: 50 },
        logger: createTestLogger('eventing-kafka'),
      })
      adapters.push(adapter)
      await adapter.initialize()

      await adapter.produce({
        topic,
        name: event.event,
        key: 'user-1',
        payload: { id: 'user-1' },
        headers: { source: 'integration' },
      })

      const received: unknown[] = []
      const controller = new AbortController()
      const consumer = await adapter.consume(
        {
          topics: [topic],
          groupId,
          consumerId: `${clientId}-consumer`,
          from: 'earliest',
          signal: controller.signal,
        },
        async (message) => {
          received.push(message)
          controller.abort()
        },
      )

      await waitFor(() => received.length === 1)
      await consumer.close()
      expect(received).toMatchObject([
        {
          topic,
          name: event.event,
          key: 'user-1',
          payload: { id: 'user-1' },
          headers: { source: 'integration' },
        },
      ])

      await waitFor(async () => {
        const offsets = await admin.listConsumerGroupOffsets({
          groups: [
            { groupId, topics: [{ name: topic, partitionIndexes: [0] }] },
          ],
        })
        return offsets[0]?.topics[0]?.partitions[0]?.committedOffset === 1n
      })

      const replayed: unknown[] = []
      const replayConsumer = await adapter.consume(
        {
          topics: [topic],
          groupId,
          consumerId: `${clientId}-consumer-2`,
          from: 'committed',
        },
        async (message) => {
          replayed.push(message)
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      await replayConsumer.close()
      expect(replayed).toEqual([])
    })

    it('does not commit failed messages and replays them for the same group', async () => {
      const topic = createTestName('events-kafka-failure')
      const groupId = createTestName('group')
      const clientId = createTestName('client')
      topics.add(topic)
      const stream = SubscriptionContract({
        namespace: topic,
        params: t.object({ id: t.string() }),
        key: ({ id }) => id,
        events: {
          orderCreated: EventContract({
            payload: t.object({ id: t.string() }),
          }),
        },
      })
      const event = stream.events.orderCreated
      const admin = await createKafkaTopic({
        topic,
        clientId: `${clientId}-admin`,
      })

      const adapter = await createKafkaAdapter(clientId)

      await adapter.produce({
        topic,
        name: event.event,
        key: 'order-1',
        payload: { id: 'order-1' },
        headers: { source: 'failure-test' },
      })

      const failedConsumer = await adapter.consume(
        {
          topics: [topic],
          groupId,
          consumerId: `${clientId}-consumer-fail`,
          from: 'earliest',
        },
        async () => {
          throw new Error('handler failed')
        },
      )
      await expect(failedConsumer.closed).rejects.toThrow('handler failed')

      const committedBeforeReplay = await getCommittedOffset(
        admin,
        groupId,
        topic,
      )
      expect(committedBeforeReplay).not.toBe(1n)

      const received: unknown[] = []
      const controller = new AbortController()
      const replayConsumer = await adapter.consume(
        {
          topics: [topic],
          groupId,
          consumerId: `${clientId}-consumer-replay`,
          from: 'earliest',
          signal: controller.signal,
        },
        async (message) => {
          received.push(message)
          controller.abort()
        },
      )

      await waitFor(() => received.length === 1)
      await replayConsumer.close()
      expect(received).toMatchObject([
        {
          topic,
          name: event.event,
          key: 'order-1',
          payload: { id: 'order-1' },
          headers: { source: 'failure-test' },
        },
      ])

      await waitFor(
        async () => (await getCommittedOffset(admin, groupId, topic)) === 1n,
      )
    })

    it('retries subscription handlers before committing delivered messages', async () => {
      const topic = createTestName('events-kafka-retry')
      const groupId = createTestName('group')
      const clientId = createTestName('client')
      topics.add(topic)
      const stream = SubscriptionContract({
        namespace: topic,
        params: t.object({ id: t.string() }),
        key: ({ id }) => id,
        events: {
          userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
        },
      })
      const events = implement(stream)
      const admin = await createKafkaTopic({
        topic,
        clientId: `${clientId}-admin`,
      })
      const adapter = await createKafkaAdapter(clientId)
      const container = new Container({
        logger: createTestLogger('eventing-kafka-retry-container'),
      })
      const runner = new EventingRunner(
        { logger: createTestLogger('eventing-kafka-retry'), container },
        { adapter },
      )
      let attempts = 0
      const handled: unknown[] = []

      try {
        await runner.start({
          consumers: [
            events(
              {
                userCreated: events.userCreated({
                  retry: { attempts: 3 },
                  async handler(_ctx, event) {
                    attempts++
                    if (attempts < 3) throw new Error('retry me')
                    handled.push(event)
                  },
                }),
              },
              { groupId, consumerId: `${clientId}-consumer`, from: 'earliest' },
            ),
          ],
        })

        await adapter.produce({
          topic,
          name: stream.events.userCreated.event,
          key: 'user-1',
          payload: { id: 'user-1' },
          headers: { source: 'retry-test' },
        })

        await waitFor(() => handled.length === 1)
        expect(attempts).toBe(3)
        expect(handled).toEqual([
          {
            namespace: topic,
            event: 'userCreated',
            key: 'user-1',
            payload: { id: 'user-1' },
            headers: { source: 'retry-test' },
          },
        ])
        await waitFor(
          async () => (await getCommittedOffset(admin, groupId, topic)) === 1n,
        )
      } finally {
        await runner.dispose()
      }
    })

    async function createKafkaTopic(options: {
      topic: string
      clientId: string
    }) {
      const admin = new Admin({
        clientId: options.clientId,
        bootstrapBrokers: kafkaBrokers!,
      })
      admins.push(admin)
      await admin.createTopics({
        topics: [options.topic],
        partitions: 1,
        replicas: 1,
      })
      return admin
    }

    async function createKafkaAdapter(clientId: string) {
      const adapter = new KafkaEventingAdapter({
        clientId,
        bootstrapBrokers: kafkaBrokers!,
        producer: { autocreateTopics: true },
        consumer: { maxWaitTime: 50 },
        logger: createTestLogger('eventing-kafka'),
      })
      adapters.push(adapter)
      await adapter.initialize()
      return adapter
    }

    async function getCommittedOffset(
      admin: Admin,
      groupId: string,
      topic: string,
    ) {
      const offsets = await admin.listConsumerGroupOffsets({
        groups: [{ groupId, topics: [{ name: topic, partitionIndexes: [0] }] }],
      })
      return offsets[0]?.topics[0]?.partitions[0]?.committedOffset
    }
  },
)

async function closeAdmin(admin: Admin) {
  await admin.close()
}
