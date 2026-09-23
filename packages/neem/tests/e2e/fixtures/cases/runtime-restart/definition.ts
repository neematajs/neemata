import { threadId } from 'node:worker_threads'

import { record } from '../../shared/support/_events.ts'

export const definition = { marker: 'v1', upstream: false, startDelayMs: 0 }
// 'patched' fails only a generation that replaces another in its thread.
export const failStart: string = 'never'

type HotData = { marker?: string }
type Hot = { dispose(callback: (data: HotData) => void): void }

const hot = (import.meta as ImportMeta & { hot?: Hot }).hot
hot?.dispose((data) => {
  record({
    event: 'definition-dispose',
    threadId,
    marker: definition.marker,
    previous: data.marker,
  })
  data.marker = definition.marker
})
