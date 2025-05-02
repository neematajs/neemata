export interface TypeProvider {
  readonly input: unknown
  readonly output: unknown
}

export type CallTypeProvider<T extends TypeProvider, V> = (T & {
  input: V
})['output']

export type ClassConstructor<T> = new (...args: any[]) => T
export type ClassInstance<T> = T extends ClassConstructor<infer U> ? U : never
export type ClassConstructorArgs<T, A = never> = T extends new (
  ...args: infer U
) => any
  ? U
  : A

export type Callback<T extends any[] = any[], R = any> = (...args: T) => R
export type OmitFirstItem<T extends any[]> = T extends [any, ...infer U]
  ? U
  : []
export type ErrorClass = new (...args: any[]) => Error
export type Extra = Record<string, any>
export type Async<T> = T | Promise<T>

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
