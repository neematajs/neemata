import type { TProperties, TSchema } from '@sinclair/typebox'
import type * as Types from '@sinclair/typebox'
import type { TDefault } from './schemas/default.ts'

export type StaticInputEncode<Type extends TSchema> =
  Type extends Types.TOptional<TSchema>
    ? Types.StaticEncode<Type> | undefined
    : Types.StaticEncode<Type>

export type StaticInputDecode<Type extends TSchema> =
  Type extends Types.TOptional<TSchema>
    ? Types.StaticDecode<Type> | undefined
    : Types.StaticDecode<Type>

export type StaticOutputEncode<Type extends TSchema> = Types.StaticEncode<
  TMap<Type, StaticOutputMapping>
>

export type StaticOutputDecode<Type extends TSchema> = Types.StaticDecode<
  TMap<Type, StaticOutputMapping>
>

interface StaticOutputMapping extends TMapping {
  output: this['input']
}

interface TMapping {
  input: unknown
  output: unknown
}

type TApply<
  Type extends TSchema,
  Mapping extends TMapping,
  Mapped = (Mapping & { input: Type })['output'],
  Result = Mapped extends TSchema ? Mapped : never,
> = Result

type TFromProperties<
  Properties extends TProperties,
  Mapping extends TMapping,
  Result extends TProperties = {
    [Key in keyof Properties]: TMap<Properties[Key], Mapping>
  },
> = Result

type TFromRest<
  Types extends TSchema[],
  Mapping extends TMapping,
  Result extends TSchema[] = [],
> = Types extends [infer Left extends TSchema, ...infer Right extends TSchema[]]
  ? TFromRest<Right, Mapping, [...Result, TMap<Left, Mapping>]>
  : Result

type TFromType<
  Type extends TSchema,
  Mapping extends TMapping,
  Result extends TSchema = TApply<Type, Mapping>,
> = Result

type UnwrapDefault<T extends TSchema> = T extends TDefault<infer U>
  ? U extends Types.TOptional<infer V>
    ? V
    : U
  : T

type TMap<
  Type extends TSchema,
  Mapping extends TMapping,
  // Maps the Exterior Type
  Exterior extends TSchema = TFromType<Type, Mapping>,
  // Maps the Interior Parameterized Types
  Interior extends TSchema = Exterior extends Types.TConstructor<
    infer Parameters extends TSchema[],
    infer ReturnType extends TSchema
  >
    ? Types.TConstructor<
        TFromRest<Parameters, Mapping>,
        TFromType<ReturnType, Mapping>
      >
    : Exterior extends Types.TFunction<
          infer Parameters extends TSchema[],
          infer ReturnType extends TSchema
        >
      ? Types.TFunction<
          TFromRest<Parameters, Mapping>,
          TFromType<ReturnType, Mapping>
        >
      : Exterior extends Types.TIntersect<infer Types extends TSchema[]>
        ? Types.TIntersect<TFromRest<Types, Mapping>>
        : Exterior extends Types.TUnion<infer Types extends TSchema[]>
          ? Types.TUnion<TFromRest<Types, Mapping>>
          : Exterior extends Types.TTuple<infer Types extends TSchema[]>
            ? Types.TTuple<TFromRest<Types, Mapping>>
            : Exterior extends Types.TArray<infer Type extends TSchema>
              ? Types.TArray<TFromType<Type, Mapping>>
              : Exterior extends Types.TAsyncIterator<
                    infer Type extends TSchema
                  >
                ? Types.TAsyncIterator<TFromType<Type, Mapping>>
                : Exterior extends Types.TIterator<infer Type extends TSchema>
                  ? Types.TIterator<TFromType<Type, Mapping>>
                  : Exterior extends Types.TPromise<infer Type extends TSchema>
                    ? Types.TPromise<TFromType<Type, Mapping>>
                    : Exterior extends Types.TObject<
                          infer Properties extends TProperties
                        >
                      ? Types.TObject<TFromProperties<Properties, Mapping>>
                      : Exterior extends Types.TRecord<
                            infer Key extends TSchema,
                            infer Value extends TSchema
                          >
                        ? Types.TRecordOrObject<
                            TFromType<Key, Mapping>,
                            TFromType<Value, Mapping>
                          >
                        : Exterior,
  // Modifiers Derived from Exterior Type Mapping
  IsOptional extends number = Exterior extends Types.TOptional<TSchema> ? 1 : 0,
  IsReadonly extends number = Exterior extends Types.TReadonly<TSchema> ? 1 : 0,
  Result extends TSchema = [IsReadonly, IsOptional] extends [1, 1]
    ? Types.TReadonly<UnwrapDefault<Interior>>
    : [IsReadonly, IsOptional] extends [0, 1]
      ? UnwrapDefault<Interior>
      : [IsReadonly, IsOptional] extends [1, 0]
        ? Types.TReadonly<UnwrapDefault<Interior>>
        : UnwrapDefault<Interior>,
> = Result
