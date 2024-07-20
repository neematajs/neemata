import { describe, expect, it } from 'vitest'

import { JsonTypeBuilder } from '@sinclair/typebox/type'

import { Contract } from '../src/contract.ts'
import { EventContract } from '../src/schemas/event.ts'
import { ProcedureContract } from '../src/schemas/procedure.ts'
import { ServiceContract } from '../src/schemas/service.ts'
import { SubscriptionContract } from '../src/schemas/subscription.ts'

describe('Contract', () => {
  it('"Contract" should be defined', () => {
    expect(Contract).toBeDefined()
  })

  it('should expose built-in JSON types', () => {
    for (const key of Object.keys(JsonTypeBuilder.prototype)) {
      expect(Contract).toHaveProperty(key, JsonTypeBuilder.prototype[key])
    }
  })

  it('should export Service contract', () => {
    expect(Contract).toHaveProperty('Service', ServiceContract)
  })

  it('should export Procedure contract', () => {
    expect(Contract).toHaveProperty('Procedure', ProcedureContract)
  })

  it('should export Subscription contract', () => {
    expect(Contract).toHaveProperty('Subscription', SubscriptionContract)
  })

  it('should export Event contract', () => {
    expect(Contract).toHaveProperty('Event', EventContract)
  })
})
