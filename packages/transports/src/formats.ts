import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

/**
 * Default native codec registry for the native (Neemata-protocol) handlers.
 * Formats are a projection capability: each native handler owns its own
 * registry and negotiates per connection; this is only the omitted-option
 * default (D13).
 */
export function createDefaultFormats(): ProtocolFormats {
  return new ProtocolFormats([new JsonFormat(), new MsgpackFormat()])
}
