import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'

export type WorkflowRedisClient = Redis | Valkey
