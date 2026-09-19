import type { TProcedureContract, TStreamContract } from '@nmtjs/contract'
import type { Container } from '@nmtjs/core'
import type { GatewayConnection } from '@nmtjs/gateway'
import type { AnyCompatibleType, BaseTypeAny } from '@nmtjs/type'

import type { Procedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'

export type ApiCallProcedure<Payload> = Procedure<
  | TProcedureContract<
      AnyCompatibleType<any, Payload>,
      BaseTypeAny,
      string | undefined
    >
  | TStreamContract<
      AnyCompatibleType<any, Payload>,
      BaseTypeAny,
      string | undefined
    >,
  any
>

export type ApiCallContext<Payload = unknown> = Readonly<{
  callId: string
  connection: GatewayConnection
  container: Container
  path: AnyRouter[]
  procedure: ApiCallProcedure<Payload>
}>

export type ApiGuardContext<Payload = unknown> = ApiCallContext<Payload> &
  Readonly<{ payload: Payload }>
