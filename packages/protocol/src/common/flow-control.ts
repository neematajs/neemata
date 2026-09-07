import { MAX_UINT32 } from '@nmtjs/common'

export const DEFAULT_BLOB_CHUNK_SIZE = 64 * 1024
export const DEFAULT_BLOB_CREDIT_WINDOW = 1024 * 1024
export const DEFAULT_BLOB_CREDIT_REFILL = DEFAULT_BLOB_CREDIT_WINDOW / 2
export const STREAM_FLOW_CONTROL_VIOLATION_REASON =
  'stream flow control violation'

export type CreditWindowOptions = {
  capacity: number
  refill: number
}

const isCreditAmount = (amount: number) =>
  Number.isInteger(amount) && amount > 0 && amount <= MAX_UINT32

const assertCreditAmount = (name: string, amount: number) => {
  if (!isCreditAmount(amount)) {
    throw new RangeError(`${name} must be a positive uint32 integer`)
  }
}

const assertConsumedAmount = (amount: number) => {
  if (!Number.isInteger(amount) || amount < 0 || amount > MAX_UINT32) {
    throw new RangeError('consumed must be a uint32 integer')
  }
}

/**
 * Owns the receiver side of a credit window: local demand determines when
 * grants are issued, while incoming data is checked against those grants.
 */
export class ReceiveCreditWindow {
  readonly capacity: number
  readonly refill: number

  #started = false
  #consumed = 0
  #outstanding = 0

  constructor(options: CreditWindowOptions) {
    assertCreditAmount('capacity', options.capacity)
    assertCreditAmount('refill', options.refill)
    if (options.refill > options.capacity) {
      throw new RangeError('refill must not exceed capacity')
    }

    this.capacity = options.capacity
    this.refill = options.refill
  }

  get outstanding() {
    return this.#outstanding
  }

  /** Returns the next grant to send, or zero while demand is below refill. */
  onDemand(consumed = 0): number {
    assertConsumedAmount(consumed)

    if (!this.#started) {
      this.#started = true
      this.#outstanding = this.capacity
      return this.capacity
    }

    this.#consumed = Math.min(this.#consumed + consumed, this.capacity)
    if (this.#consumed < this.refill) return 0

    const availableCapacity = this.capacity - this.#outstanding
    const grant = Math.min(this.#consumed, availableCapacity)
    if (grant === 0) return 0

    this.#consumed -= grant
    this.#outstanding += grant
    return grant
  }

  /** Returns false when incoming data exceeds the outstanding grant. */
  accept(amount: number): boolean {
    if (!isCreditAmount(amount) || amount > this.#outstanding) return false
    this.#outstanding -= amount
    return true
  }

  /** Rolls back a grant that did not reach the sender. */
  revoke(amount: number): boolean {
    if (!isCreditAmount(amount) || amount > this.#outstanding) return false
    this.#outstanding -= amount
    return true
  }
}

/** Tracks credit granted by a receiver and spent by a sender. */
export class SendCredits {
  #available = 0

  get available() {
    return this.#available
  }

  grant(amount: number): boolean {
    if (!isCreditAmount(amount) || this.#available + amount > MAX_UINT32) {
      return false
    }

    this.#available += amount
    return true
  }

  spend(amount: number): boolean {
    if (!isCreditAmount(amount) || amount > this.#available) return false
    this.#available -= amount
    return true
  }
}
