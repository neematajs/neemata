import { kTransportPlugin } from './constants.ts'
import type { BasePlugin } from './plugin.ts'

export type TransportType = {
  start: () => Promise<void>
  stop: () => Promise<void>
}

export interface TransportPlugin<Options = unknown>
  extends BasePlugin<TransportType, Options> {
  [kTransportPlugin]: any
}

export const createTransport = <Options = unknown>(
  name: string,
  init: TransportPlugin<Options>['init'],
): TransportPlugin<Options> => ({ name, init, [kTransportPlugin]: true })
