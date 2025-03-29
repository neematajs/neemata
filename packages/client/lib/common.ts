import { ProtocolError } from '@nmtjs/protocol/client'

export * from './types.ts'

export class ClientError extends ProtocolError {}

export {
  ProtocolBlob,
  ErrorCode,
  TransportType,
  type ProtocolBlobMetadata,
} from '@nmtjs/protocol/common'
