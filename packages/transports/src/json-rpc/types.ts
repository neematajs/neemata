export interface JsonRpcHandlerOptions {
  path: `/${string}`
  /**
   * Maximum number of requests accepted in one JSON-RPC batch.
   * @default 100
   */
  maxBatchSize?: number
  /**
   * Overrides the host request body size limit for this handler.
   * Must not exceed the host limit.
   */
  maxRequestBodySize?: number
  /**
   * Native procedure name patterns to expose. When omitted, every unary
   * procedure is exposed. Patterns: exact (`users/create`), subtree
   * (`users/*`) or `*`.
   */
  include?: string[]
  /**
   * Native procedure name patterns to hide. Applied after `include`.
   */
  exclude?: string[]
}

export type JsonRpcId = string | number | null

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcErrorObject
}
