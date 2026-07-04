import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'

import { record } from '../../shared/support/_events.ts'

type FileUrlWorkerOptions = { label: string }
type FileUrlWorkerDefinition = { fixture: 'file-url-entry' }

export default defineRuntimeWorker<
  FileUrlWorkerOptions,
  FileUrlWorkerDefinition
>({
  definition: { fixture: 'file-url-entry' },
  createRuntime(
    ctx: NeemRuntimeWorkerContext<
      FileUrlWorkerOptions,
      FileUrlWorkerDefinition
    >,
  ) {
    record({
      event: 'file-url-worker-create',
      name: ctx.name,
      data: ctx.data,
      definition: ctx.definition,
    })

    return {
      start() {
        record({ event: 'file-url-worker-start', name: ctx.name })
      },
      stop() {
        record({ event: 'file-url-worker-stop', name: ctx.name })
      },
    }
  },
})
