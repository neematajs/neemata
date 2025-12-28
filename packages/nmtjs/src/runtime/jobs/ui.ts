import { createServer } from 'node:http'

import type { Queue } from 'bullmq'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { H3Adapter } from '@bull-board/h3'
import { createApp, toNodeListener } from 'h3'

export function createJobsUI(queues: Queue[]) {
  const app = createApp()
  const serverAdapter = new H3Adapter()
  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q, { readOnlyMode: true })),
    serverAdapter,
  })
  const router = serverAdapter.registerHandlers()
  app.use(router)
  return createServer(toNodeListener(app))
}

export type JobsUI = ReturnType<typeof createJobsUI>
