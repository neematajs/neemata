export * from './format.ts'
export * from './protocol.ts'
export * from './stream.ts'
export * from './streams.ts'

import { ProtocolVersion } from '../common/enums.ts'
import { ProtocolVersion1 } from './versions/v1.ts'

export const versions = { [ProtocolVersion.v1]: new ProtocolVersion1() }
