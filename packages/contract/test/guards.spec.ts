import { describe, expect, it } from 'vitest'

import { Contract, Type } from '../src/contract.ts'
import { ContractGuard } from '../src/guards.ts'

describe('Guards', () => {
  for (const key of [...Object.keys(Type), ...Object.keys(Contract)]) {
    const propName = `Is${key}`
    it(`should expose "${propName}" guards`, () => {
      expect(ContractGuard).toHaveProperty(propName, expect.any(Function))
    })
  }
})
