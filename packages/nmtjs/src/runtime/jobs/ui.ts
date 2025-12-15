import type { Queue } from 'bullmq'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { H3Adapter } from '@bull-board/h3'
import { createApp, createRouter } from 'h3'

export function createJobsUI(queues: Queue[]) {
  const app = createApp()
  const router = createRouter()
  const serverAdapter = new H3Adapter()
  serverAdapter.setBasePath('/')
  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  })
  app.use(router)
  app.use(serverAdapter.registerHandlers())
  return app
}
