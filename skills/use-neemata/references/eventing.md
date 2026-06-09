# Eventing

Use eventing for durable subscription delivery: consumer groups, replay,
offsets, retry/dead-letter policy, and restart recovery. Eventing consumes
subscription contracts; it does not define public contract shape.

```ts
import { implementSubscription, inject } from 'nmtjs'
import { users } from './subscriptions.ts'

const events = implementSubscription(users)

export const usersConsumer = events(
  {
    created: events.created({
      dependencies: { logger: inject.logger },
      async handler({ logger }, event, message) {
        logger.info(
          { userId: event.payload.id, topic: message.topic, key: message.key },
          'user created',
        )
      },
    }),
  },
  { groupId: 'users-service', from: 'earliest', unhandled: 'fail' },
)
```

## Rules

- `implementSubscription(contract)` creates typed durable subscription
  consumers.
- Handler map may be partial. Unknown event keys and mismatched event contracts
  are rejected.
- Handler receives `(ctx, event, message)`. `event.payload` is decoded from the
  event contract.
- Consumer options include `groupId`, optional `consumerId`, `from`,
  `recoverPending`, `retry`, `deadLetter`, and `unhandled`.
- Logger is not injected automatically. Request `inject.logger`.
- Eventing sends subscription `namespace` as adapter topic and event name
  separately; adapters decide broker-specific encoding.

## Runtime Helpers And Adapter

Package-owned runtime helpers stay on package subpaths:

```ts
import { defineRuntime } from '@nmtjs/neem'
import { defineEventing } from '@nmtjs/eventing/neem'
import { defineEventingPlanner } from '@nmtjs/eventing/neem/planner'
import { defineEventingWorker } from '@nmtjs/eventing/neem/worker'
import { RedisStreamsEventingAdapter } from '@nmtjs/eventing/redis'
```

Generic runtime layout:

- `config.ts` exports `defineEventing({ adapter, consumers })`.
- `neem.runtime.ts` exports raw `defineRuntime({ name, planner, worker })`.
- `neem.planner.ts` exports `defineEventingPlanner(() => config)`.
- `neem.worker.ts` exports `defineEventingWorker(config)`.

Eventing has no package-owned host entry and no common worker build defaults, so
there is no eventing runtime factory. The app owns the runtime declaration.
