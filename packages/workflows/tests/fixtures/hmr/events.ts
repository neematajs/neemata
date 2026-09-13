import { createLogger } from '@nmtjs/core'

const eventPrefix = 'NEEM_RUNTIME_EVENT '
const logger = createLogger(
  {
    destinations: [
      {
        level: 'info',
        stream: {
          write(line: string) {
            process.stdout.write(`${eventPrefix}${line}`)
          },
        },
      },
    ],
  },
  'HMR fixture',
)

export function record(event: Record<string, unknown>): void {
  logger.info(event)
}
