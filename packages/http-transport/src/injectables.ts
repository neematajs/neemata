import { createLazyInjectable, Scope } from '@nmtjs/core'
import { connectionData as connectionDataInjectable } from '@nmtjs/gateway'

import type { HttpTransportServerRequest } from './types.ts'

export const connectionData =
  connectionDataInjectable.$withType<HttpTransportServerRequest>()

export const httpResponseHeaders = createLazyInjectable<Headers, Scope.Call>(
  Scope.Call,
)
