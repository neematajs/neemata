import { threadId } from 'node:worker_threads'

import pino from 'pino'

const eventPrefix = 'NEEM_RUNTIME_EVENT '
const logger = pino(
  {},
  {
    write(line: string) {
      process.stdout.write(`${eventPrefix}${line}`)
    },
  },
)

export function record(event: Record<string, unknown>): void {
  logger.info({ ...event, threadId })
}
