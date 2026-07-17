import type { BaseProtocolError } from './types.ts'
import { ErrorCode } from './enums.ts'

export class ProtocolError extends Error implements BaseProtocolError {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  // code stays out of `message` so serialization round-trips don't
  // accumulate "CODE CODE message" prefixes
  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return {
      name: this.code,
      message: this.message,
      data: this.data,
      code: this.code,
    }
  }
}

// Errors must be normalized before reaching an encoder: JSON serializes a
// plain Error to `{}` (its fields are non-enumerable), losing code and
// message entirely. Unexpected errors are sanitized to a generic response
// so internals never leak to the wire.
export const toProtocolError = (error: unknown): ProtocolError => {
  if (error instanceof ProtocolError) return error
  return new ProtocolError(
    ErrorCode.InternalServerError,
    'Internal Server Error',
  )
}
