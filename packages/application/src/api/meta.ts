import type { TAnyCallableContract, TAnyRouterContract } from '@nmtjs/contract'
import type {
  AnyMeta,
  AfterDecodeMetaBinding as CoreAfterDecodeMetaBinding,
  AnyFactoryMetaBinding as CoreAnyFactoryMetaBinding,
  BeforeDecodeMetaBinding as CoreBeforeDecodeMetaBinding,
  Meta as CoreMeta,
  MetaFactoryBinding as CoreMetaFactoryBinding,
  Container,
  Dependencies,
  MetaPhase,
  StaticMetaBinding,
} from '@nmtjs/core'
import type { GatewayConnection } from '@nmtjs/gateway'
import { createMeta as createCoreMeta, MetadataKind } from '@nmtjs/core'

export type { AnyMeta, MetaPhase, StaticMetaBinding }
export { MetadataKind }

export type ApiMetaRouteContext = Readonly<{
  contract: TAnyRouterContract
  timeout?: number
}>

export type ApiMetaProcedureContext = Readonly<{
  contract: TAnyCallableContract
  streamTimeout?: number
}>

export type ApiMetaContext = Readonly<{
  callId: string
  connection: GatewayConnection
  container: Container
  path: readonly ApiMetaRouteContext[]
  procedure: ApiMetaProcedureContext
}>

export type Meta<Value, Kind extends MetadataKind = MetadataKind> = CoreMeta<
  Value,
  Kind,
  ApiMetaContext
>

export type BeforeDecodeMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
> = CoreBeforeDecodeMetaBinding<T, Deps, ApiMetaContext>

export type AfterDecodeMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
  Input = unknown,
> = CoreAfterDecodeMetaBinding<T, Deps, ApiMetaContext, Input>

export type MetaFactoryBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
  Phase extends MetaPhase = MetaPhase,
  Input = unknown,
> = CoreMetaFactoryBinding<T, Deps, Phase, ApiMetaContext, Input>

export type AnyFactoryMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = Dependencies,
  Phase extends MetaPhase = MetaPhase,
  Input = unknown,
> = CoreAnyFactoryMetaBinding<T, Deps, Phase, ApiMetaContext, Input>

export type AnyMetaBinding = StaticMetaBinding | AnyFactoryMetaBinding

export type StaticOrBeforeDecodeMetaBinding =
  | StaticMetaBinding
  | BeforeDecodeMetaBinding<AnyMeta, any>

export type CompatibleMetaBinding<Input> =
  | StaticOrBeforeDecodeMetaBinding
  | AfterDecodeMetaBinding<AnyMeta, any, Input>

export type AnyCompatibleMetaBinding = CompatibleMetaBinding<any>

export function createMeta<
  Value,
  Kind extends MetadataKind = MetadataKind,
>(): Meta<Value, Kind> {
  return createCoreMeta<Value, Kind, ApiMetaContext>() as Meta<Value, Kind>
}
