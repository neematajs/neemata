import type { ConnectionType } from '@nmtjs/protocol'

declare module '@nmtjs/runtime/types' {
  interface Transports {
    ws: import('nmtjs/gateway').TransportV2<ConnectionType.Bidirectional>
  }
}
