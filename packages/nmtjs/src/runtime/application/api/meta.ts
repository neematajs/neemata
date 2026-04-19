import type { TAnyProcedureContract, TAnyRouterContract } from '@nmtjs/contract'
import type {
  AfterDecodeMetaBinding,
  AnyMeta,
  BeforeDecodeMetaBinding,
  Container,
  StaticMetaBinding,
} from '@nmtjs/core'
import type { GatewayConnection } from '@nmtjs/gateway'

export type ApiMetaRouteContext = Readonly<{
  contract: TAnyRouterContract
  timeout?: number
}>

export type ApiMetaProcedureContext = Readonly<{
  contract: TAnyProcedureContract
  streamTimeout?: number
}>

export type ApiMetaContext = Readonly<{
  callId: string
  connection: GatewayConnection
  container: Container
  path: readonly ApiMetaRouteContext[]
  procedure: ApiMetaProcedureContext
}>

export type StaticOrBeforeDecodeMetaBinding =
  | StaticMetaBinding
  | BeforeDecodeMetaBinding<AnyMeta, any, ApiMetaContext>

export type CompatibleMetaBinding<Input> =
  | StaticOrBeforeDecodeMetaBinding
  | AfterDecodeMetaBinding<AnyMeta, any, ApiMetaContext, Input>

export type AnyCompatibleMetaBinding = CompatibleMetaBinding<any>
