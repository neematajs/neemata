import type { BaseClientFormat } from '@nmtjs/protocol/client'
import type { BaseServerFormat } from '@nmtjs/protocol/server'
import { JsonFormat as ClientJsonFormat } from '@nmtjs/json-format/client'
import { JsonFormat as ServerJsonFormat } from '@nmtjs/json-format/server'

export type { BaseClientFormat, BaseServerFormat }

export function createTestServerFormat(): BaseServerFormat {
  return new ServerJsonFormat()
}

export function createTestClientFormat(): BaseClientFormat {
  return new ClientJsonFormat()
}
