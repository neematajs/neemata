import { appendFileSync } from 'node:fs'

import { pino } from 'pino'

const flushFile = process.env.NEEM_LOG_FLUSH_FILE
let buffered = ''

// Stands in for a batching destination: lines reach the file only through an
// asynchronous flush, so a thread that exits without awaiting it loses them.
const destination = {
  write(line: string) {
    buffered += line
  },
  flush(callback: () => void) {
    setTimeout(() => {
      if (flushFile && buffered) appendFileSync(flushFile, buffered)
      buffered = ''
      callback()
    }, 20)
  },
}

export default pino(
  { enabled: Boolean(flushFile), level: 'trace' },
  destination,
)
