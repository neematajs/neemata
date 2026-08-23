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

  // Keeping the code separate prevents repeated wire round trips from
  // compounding it in the human-readable message.
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

// Normalizing here keeps plain Error internals off the wire and avoids JSON
// serializing their non-enumerable fields as an empty object.
export const toProtocolError = (error: unknown): ProtocolError => {
  if (error instanceof ProtocolError) return error
  return new ProtocolError(
    ErrorCode.InternalServerError,
    'Internal Server Error',
  )
}
