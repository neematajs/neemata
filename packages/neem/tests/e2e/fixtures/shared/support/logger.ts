import { appendFileSync } from 'node:fs'

import { createLogger } from '@nmtjs/core'

const eventsFile = process.env.NEEM_LOG_EVENTS_FILE

export default createLogger(
  eventsFile
    ? {
        destinations: [
          {
            level: 'trace',
            stream: {
              write(line: string) {
                appendFileSync(eventsFile, line)
              },
            },
          },
        ],
      }
    : { pinoOptions: { enabled: false } },
  'Fixture',
)
