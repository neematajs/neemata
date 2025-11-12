import type { Async } from '@nmtjs/common'

import type { GatewayConnection } from './connection.ts'
import type { GatewayHook } from './enums.ts'

export type ConnectionIndentityResolver = () => Async<string>

declare module '@nmtjs/core' {
  export interface HookTypes {
    [GatewayHook.Connect]: [connection: GatewayConnection]
    [GatewayHook.Disconnect]: [connection: GatewayConnection]
  }
}
