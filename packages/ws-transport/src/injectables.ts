import { connectionData as connectionDataInjectable } from '@nmtjs/gateway'

import type { WsTransportServerRequest } from './types.ts'

export const connectionData =
  connectionDataInjectable.$withType<WsTransportServerRequest>()
