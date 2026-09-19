import type { BaseProtocolError } from './types.ts'

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
