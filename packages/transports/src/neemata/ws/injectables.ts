import { connectionData as connectionDataInjectable } from '@nmtjs/gateway'

import type { NeemataWebSocketRequest } from './types.ts'

export const connectionData =
  connectionDataInjectable.$withType<NeemataWebSocketRequest>()
