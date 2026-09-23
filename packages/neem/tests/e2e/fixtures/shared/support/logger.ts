import { appendFileSync } from 'node:fs'

import { pino } from 'pino'

const eventsFile = process.env.NEEM_LOG_EVENTS_FILE

export default pino(
  { enabled: Boolean(eventsFile), level: 'trace', base: { $label: 'Fixture' } },
  {
    write(line: string) {
      if (eventsFile) appendFileSync(eventsFile, line)
    },
  },
)
