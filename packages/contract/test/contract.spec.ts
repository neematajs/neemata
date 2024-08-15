import { describe, expect, it } from 'vitest'

import { JavaScriptTypeBuilder, JsonTypeBuilder } from '@sinclair/typebox/type'

import { Contract, Type } from '../src/contract.ts'
import { BlobType } from '../src/schemas/blob.ts'
import { EventContract } from '../src/schemas/event.ts'
import { ProcedureContract } from '../src/schemas/procedure.ts'
import { ServiceContract } from '../src/schemas/service.ts'
import { SubscriptionContract } from '../src/schemas/subscription.ts'

describe('Contract', () => {
  it('Contract should be defined', () => {
    expect(Contract).toBeDefined()
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

  it('should export Blob contract', () => {
    expect(Type).toHaveProperty('Blob', BlobType)
  })

  const jsonDescriptors = Object.getOwnPropertyDescriptors(
    JsonTypeBuilder.prototype,
  )

  for (const [key, descr] of Object.entries(jsonDescriptors)) {
    if (key === 'constructor') continue
    it(`should expose ${key} type`, () => {
      expect(Type).toHaveProperty(key, descr.value)
    })
  }

  const jsDescriptors = Object.getOwnPropertyDescriptors(
    JavaScriptTypeBuilder.prototype,
  )

  for (const key of Object.keys(jsDescriptors)) {
    if (key === 'constructor') continue
    it(`should not expose ${key} type`, () => {
      expect(typeof Type[key]).toBe('undefined')
    })
  }
})
