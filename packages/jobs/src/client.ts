import type { MaybePromise } from '@nmtjs/common'
import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'

export type JobsClientInstance = Redis | Valkey

/**
 * Jobs runtime owns returned client lifecycle and closes it on stop.
 * Return a duplicated client when sharing the same Redis/Valkey connection elsewhere.
 */
export type JobsClientFactory = () => MaybePromise<JobsClientInstance>

export type JobsClient = JobsClientFactory

export async function resolveJobsClient(
  client: JobsClient,
): Promise<JobsClientInstance> {
  return await client()
}

export async function closeJobsClient(client: JobsClientInstance) {
  await client.quit()
}
