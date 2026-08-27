import { describe, expect, it } from 'vitest'

import {
  ReceiveCreditWindow,
  SendCredits,
} from '../../src/common/flow-control.ts'

describe('ReceiveCreditWindow', () => {
  it('opens with a full window and refills accepted credit in batches', () => {
    const credits = new ReceiveCreditWindow({ capacity: 16, refill: 8 })

    expect(credits.onDemand()).toBe(16)
    expect(credits.outstanding).toBe(16)

    expect(credits.accept(7)).toBe(true)
    expect(credits.onDemand(7)).toBe(0)
    expect(credits.accept(1)).toBe(true)
    expect(credits.onDemand(1)).toBe(8)
    expect(credits.outstanding).toBe(16)
  })

  it('never grants beyond the configured capacity', () => {
    const credits = new ReceiveCreditWindow({ capacity: 10, refill: 5 })

    expect(credits.onDemand()).toBe(10)
    expect(credits.accept(2)).toBe(true)
    expect(credits.onDemand(2)).toBe(0)
    expect(credits.outstanding).toBe(8)
  })

  it('rejects empty and oversized incoming data', () => {
    const credits = new ReceiveCreditWindow({ capacity: 10, refill: 5 })
    credits.onDemand()

    expect(credits.accept(0)).toBe(false)
    expect(credits.accept(11)).toBe(false)
    expect(credits.outstanding).toBe(10)
  })

  it('revokes a grant that was not delivered', () => {
    const credits = new ReceiveCreditWindow({ capacity: 10, refill: 5 })

    const grant = credits.onDemand()

    expect(credits.revoke(grant)).toBe(true)
    expect(credits.outstanding).toBe(0)
  })

  it('rejects invalid window options', () => {
    expect(() => new ReceiveCreditWindow({ capacity: 0, refill: 1 })).toThrow(
      'capacity must be a positive uint32 integer',
    )
    expect(() => new ReceiveCreditWindow({ capacity: 4, refill: 5 })).toThrow(
      'refill must not exceed capacity',
    )
  })

  it('does not collapse batched refills into one grant per small chunk', () => {
    const credits = new ReceiveCreditWindow({ capacity: 100, refill: 50 })
    const grants = [credits.onDemand()]

    for (let index = 0; index < 300; index++) {
      expect(credits.accept(1)).toBe(true)
      const grant = credits.onDemand(1)
      if (grant > 0) grants.push(grant)
    }

    expect(grants).toEqual([100, 50, 50, 50, 50, 50, 50])
  })
})

describe('SendCredits', () => {
  it('accumulates grants and spends them incrementally', () => {
    const credits = new SendCredits()

    expect(credits.grant(10)).toBe(true)
    expect(credits.grant(5)).toBe(true)
    expect(credits.spend(12)).toBe(true)
    expect(credits.available).toBe(3)
  })

  it('rejects invalid grants and overspending', () => {
    const credits = new SendCredits()

    expect(credits.grant(0)).toBe(false)
    expect(credits.grant(4)).toBe(true)
    expect(credits.spend(0)).toBe(false)
    expect(credits.spend(5)).toBe(false)
    expect(credits.available).toBe(4)
  })

  it('rejects credit overflow', () => {
    const credits = new SendCredits()

    expect(credits.grant(2 ** 32 - 1)).toBe(true)
    expect(credits.grant(1)).toBe(false)
  })
})
