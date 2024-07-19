import { StreamDataType } from '@neematajs/common'
import { Extends, Kind, type TSchema } from '@sinclair/typebox/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const UpStreamKind = 'NeemataUpStream'
export const DownStreamKind = 'NeemataDownStream'

export type UpStream = {
  __static: 'neemata:upstream'
}

export type DownStream<
  T extends StreamDataType = StreamDataType,
  P = any,
  C extends any | undefined = undefined,
> = {
  __static: 'neemata:downstream'
  __type: T
  __payload: P
  __chunk: C
}

export interface TUpStreamContract extends TSchema {
  [Kind]: typeof UpStreamKind
  static: UpStream
  type: 'neemata:upstream'
}

export const UpStreamContract = (
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) =>
  createSchema({
    ...schemaOptions,
    [Kind]: UpStreamKind,
    type: 'neemata:upstream',
  })

export interface TDownStreamContract<
  Type extends StreamDataType = StreamDataType,
  Payload extends TSchema = TSchema,
  Chunk extends TSchema | undefined = undefined,
> extends TSchema {
  [Kind]: typeof DownStreamKind
  static: DownStream<
    Type,
    Payload['static'],
    Chunk extends TSchema ? Chunk['static'] : undefined
  >
  type: 'neemata:downstream'
  dataType: Type
  payload: Payload
  chunk: Chunk
  contentType: Type extends StreamDataType.Encoded ? undefined : string
}

export const DownStreamContract = <
  Type extends StreamDataType = StreamDataType,
  Payload extends TSchema = TSchema,
  Chunk extends Type extends StreamDataType.Encoded
    ? TSchema
    : undefined = Type extends StreamDataType.Encoded ? TSchema : undefined,
>(
  dataType: Type,
  payload: Payload,
  ...[contentTypeOrChunk, schemaOptions]: Type extends StreamDataType.Encoded
    ? [Chunk, ContractSchemaOptions?]
    : [string?, ContractSchemaOptions?]
) => {
  const chunk =
    dataType === StreamDataType.Encoded ? contentTypeOrChunk : undefined
  const contentType =
    dataType === StreamDataType.Encoded
      ? undefined
      : contentTypeOrChunk ?? 'application/octet-stream'
  return createSchema<TDownStreamContract<Type, Payload, Chunk>>({
    ...schemaOptions,
    [Kind]: DownStreamKind,
    type: 'neemata:downstream',
    payload,
    dataType,
    contentType,
    chunk,
  })
}
