export type ApiBlobMetadata = {
  type: string
  size: number
  filename?: string
}

export type Rpc = {
  callId: number
  service: string
  procedure: string
  payload: any
}

export type RpcResponse = {
  callId: number
  error?: any
  payload?: any
}

export interface TypeProvider {
  readonly input: unknown
  readonly output: unknown
}

export type CallTypeProvider<T extends TypeProvider, V> = (T & {
  input: V
})['output']

export type Pattern = RegExp | string | ((value: string) => boolean)
