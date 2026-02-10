const TSErrorSymbol: unique symbol = Symbol('TSError')

export type TSError<
  ErrorMessage extends string = string,
  // biome-ignore lint/correctness/noUnusedVariables: this is used to tag the type
  TagType = never,
> = `TS Error: ${ErrorMessage}` & { [TSErrorSymbol]: true }

export interface TypeProvider {
  readonly input: unknown
  readonly output: unknown
}

export type CallTypeProvider<T extends TypeProvider, V> = (T & {
  input: V
})['output']

export type ClassConstructor<T = any, A extends any[] = any[]> =
  | (abstract new (
      ...args: A
    ) => T)
  | (new (
      ...args: A
    ) => T)

export type ClassInstance<T> = T extends ClassConstructor<infer U> ? U : never
export type ClassConstructorArgs<T, A = never> =
  T extends ClassConstructor<any, infer U> ? U : A

export type Callback<T extends any[] = any[], R = any> = (...args: T) => R
export type OmitFirstItem<T extends any[]> = T extends [any, ...infer U]
  ? U
  : []
export type ErrorClass = new (...args: any[]) => Error
export type Extra = Record<string, any>
export type MaybePromise<T> = T | Promise<T>

export type ArrayMap<T extends readonly any[], K extends keyof T[number]> = {
  [I in keyof T]: T[I][K]
}

export type UnionToIntersection<U> = (
  U extends any
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never

export type Merge<
  T1 extends Record<string, any>,
  T2 extends Record<string, any>,
> = {
  [K in keyof T1 | keyof T2]: K extends keyof T2
    ? T2[K]
    : K extends keyof T1
      ? T1[K]
      : never
}

export type OneOf<
  TypesArray extends any[],
  Res = never,
  AllProperties = MergeTypes<TypesArray>,
> = TypesArray extends [infer Head, ...infer Rem]
  ? OneOf<Rem, Res | OnlyFirst<Head, AllProperties>, AllProperties>
  : Res

type MergeTypes<TypesArray extends any[], Res = {}> = TypesArray extends [
  infer Head,
  ...infer Rem,
]
  ? MergeTypes<Rem, Res & Head>
  : Res

type OnlyFirst<F, S> = F & { [Key in keyof Omit<S, keyof F>]?: never }

export type Pattern = RegExp | string | ((value: string) => boolean)
