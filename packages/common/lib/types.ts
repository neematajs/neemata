export interface TypeProvider {
  readonly input: unknown
  readonly output: unknown
}

export type CallTypeProvider<T extends TypeProvider, V> = (T & {
  input: V
})['output']
