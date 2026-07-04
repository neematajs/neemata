import { appendFile } from 'node:fs/promises'

import { defineRuntimeWorker } from '@nmtjs/neem'

type WorkerData = { message: string }

export default defineRuntimeWorker<WorkerData>({
  definition: { fixture: 'packaging-consumer' },
  createRuntime({ data }) {
    return {
      async start() {
        await writeConsumerEvent({ event: 'start', message: data.message })
      },
      async stop() {
        await writeConsumerEvent({ event: 'stop', message: data.message })
      },
    }
  },
})

async function writeConsumerEvent(event: {
  event: string
  message: string
}): Promise<void> {
  const file = process.env.NEEM_PACKAGING_EVENTS_FILE
  if (!file) return
  await appendFile(file, `${JSON.stringify(event)}\n`)
}
