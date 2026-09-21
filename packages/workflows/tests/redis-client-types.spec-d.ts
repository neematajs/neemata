import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'

import type { WorkflowRedisClient } from '../src/adapters/redis.ts'

declare const redis: Redis
declare const valkey: Valkey

const redisClient: WorkflowRedisClient = redis
const valkeyClient: WorkflowRedisClient = valkey

void redisClient
void valkeyClient
