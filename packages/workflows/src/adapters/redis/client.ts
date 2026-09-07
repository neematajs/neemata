/**
 * Driver-neutral command surface shared by ioredis and iovalkey.
 *
 * Arguments remain variadic because the drivers publish different overloads
 * for equivalent Redis commands.
 */
export type WorkflowRedisClient = {
  readonly status: string
  duplicate(options?: { readonly lazyConnect?: boolean }): WorkflowRedisClient
  connect(): Promise<void>
  quit(): Promise<unknown>
  on(event: string, listener: (...args: any[]) => void): unknown
  subscribe(...args: any[]): Promise<unknown>
  unsubscribe(...args: any[]): Promise<unknown>
  evalsha(...args: any[]): Promise<unknown>
  script(...args: any[]): Promise<unknown>
  exists(...args: any[]): Promise<number>
  get(...args: any[]): Promise<string | null>
  hget(...args: any[]): Promise<string | null>
  hgetall(...args: any[]): Promise<Record<string, string>>
  hmget(...args: any[]): Promise<(string | null)[]>
  publish(...args: any[]): Promise<number>
}
