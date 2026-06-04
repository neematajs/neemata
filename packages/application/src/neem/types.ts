import type { NeemRuntimeWorker, NeemRuntimeWorkerContext } from '@nmtjs/neem'

import type { ApplicationTransport } from '../config.ts'
import type {
  AnyApplicationHostDefinition,
  ApplicationHostDefinition,
  TransportOptionsOf,
} from '../host.ts'

export type NeemataRuntimeTransportOptions<
  Transports extends Record<string, ApplicationTransport>,
> = {
  [K in keyof Transports]: TransportOptionsOf<Transports[K]>
}

export type NeemataRuntimeThreadOptions<
  THost extends ApplicationHostDefinition,
> =
  THost extends ApplicationHostDefinition<any, infer Transports>
    ? NeemataRuntimeTransportOptions<Transports>
    : never

export type NeemataRuntimeContext<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = NeemRuntimeWorkerContext<NeemataRuntimeThreadOptions<THost>, THost>

export type NeemataWorker<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> = NeemRuntimeWorker<NeemataRuntimeThreadOptions<THost>, THost>
