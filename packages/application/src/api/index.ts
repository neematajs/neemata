import type {
  AnyMeta,
  AfterDecodeMetaBinding as CoreAfterDecodeMetaBinding,
  AnyFactoryMetaBinding as CoreAnyFactoryMetaBinding,
  BeforeDecodeMetaBinding as CoreBeforeDecodeMetaBinding,
  Meta as CoreMeta,
  MetaFactoryBinding as CoreMetaFactoryBinding,
  Dependencies,
  MetaPhase,
  StaticMetaBinding,
} from '@nmtjs/core'
import { createMeta as createCoreMeta, MetadataKind } from '@nmtjs/core'

import type { ApiMetaContext } from './meta.ts'

export type { AnyMeta, MetaPhase, StaticMetaBinding }
export { MetadataKind }

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

export function createMeta<
  Value,
  Kind extends MetadataKind = MetadataKind,
>(): Meta<Value, Kind> {
  return createCoreMeta<Value, Kind, ApiMetaContext>() as Meta<Value, Kind>
}

export * from './api.ts'
export * from './config.ts'
export * from './constants.ts'
export * from './filters.ts'
export * from './guards.ts'
export * from './logging.ts'
export * from './meta.ts'
export * from './middlewares.ts'
export * from './procedure.ts'
export * from './router.ts'
export * from './types.ts'
