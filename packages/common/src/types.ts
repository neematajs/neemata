export interface TypeProvider {
  readonly input: unknown
  readonly output: unknown
}

export type CallTypeProvider<T extends TypeProvider, V> = (T & {
  input: V
})['output']

export type Callback<T extends any[] = any[], R = any> = (...args: T) => R
export type ErrorClass = new (...args: any[]) => Error
export type MaybePromise<T> = T | Promise<T>

export type ArrayMap<T extends readonly any[], K extends keyof T[number]> = {
  [I in keyof T]: T[I][K]
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
