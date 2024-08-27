import { describe, expect, it } from 'vitest'

import { c } from '../src/index.ts'
import { EventContract } from '../src/schemas/event.ts'
import { ProcedureContract } from '../src/schemas/procedure.ts'
import { ServiceContract } from '../src/schemas/service.ts'
import { SubscriptionContract } from '../src/schemas/subscription.ts'

describe('Contract', () => {
  it('Contract should be defined', () => {
    expect(c).toBeDefined()
  })

  it('should export Service contract', () => {
    expect(c).toHaveProperty('service', ServiceContract)
  })

  it('should export Procedure contract', () => {
    expect(c).toHaveProperty('procedure', ProcedureContract)
  })

  it('should export Subscription contract', () => {
    expect(c).toHaveProperty('subscription', SubscriptionContract)
  })

  it('should export Event contract', () => {
    expect(c).toHaveProperty('event', EventContract)
  })
})
