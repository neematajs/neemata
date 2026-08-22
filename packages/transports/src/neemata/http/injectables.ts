import { createLazyInjectable, Scope } from '@nmtjs/core'
import { connectionData as connectionDataInjectable } from '@nmtjs/gateway'

import type { NeemataHttpRequest } from './types.ts'

export const connectionData =
  connectionDataInjectable.$withType<NeemataHttpRequest>()

export const httpResponseHeaders = createLazyInjectable<Headers, Scope.Call>(
  Scope.Call,
)
