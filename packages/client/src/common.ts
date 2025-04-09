import { ProtocolError } from '@nmtjs/protocol/client'

export * from './types.ts'

export class ClientError extends ProtocolError {}

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  TransportType,
} from '@nmtjs/protocol/common'
