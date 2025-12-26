import type { BaseClientFormat } from '@nmtjs/protocol/client'
import type { BaseServerFormat } from '@nmtjs/protocol/server'
import { JsonFormat as ClientJsonFormat } from '@nmtjs/json-format/client'
import { JsonFormat as ServerJsonFormat } from '@nmtjs/json-format/server'

export type { BaseClientFormat, BaseServerFormat }

/**
 * Creates a server-side format instance for testing.
 */
export function createTestServerFormat(): BaseServerFormat {
  return new ServerJsonFormat()
}

/**
 * Creates a client-side format instance for testing.
 */
export function createTestClientFormat(): BaseClientFormat {
  return new ClientJsonFormat()
}
