import type { Queue } from 'bullmq'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import fastify from 'fastify'

export function createJobsUI(queues: Queue[]) {
  const app = fastify()
  const serverAdapter = new FastifyAdapter()
  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
    options: { uiBasePath: '/' },
  })
  app.register(serverAdapter.registerPlugin(), { prefix: '/' })
  return app
}
