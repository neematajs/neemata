import { resolve } from 'node:path'

import { createFuture, noopFn } from '@nmtjs/common'

import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeResult,
} from '../services/protocol.ts'
import { MANIFEST_FILE } from '../layout.ts'
import { createNeemTestProbe } from '../test-probe.ts'
import { deserializeError, normalizeError } from '../utils.ts'
import { createServiceClient } from './clients.ts'
import { createSignalController } from './signal.ts'

export async function startNeem(options: {
  outDir: string
  runtimes?: readonly string[]
}): Promise<void> {
  const { outDir } = options
  const manifestFile = resolve(outDir, MANIFEST_FILE)
  const probe = createNeemTestProbe()
  const controller = createSignalController()
  const closed = createFuture<void>()
  // Runtime events, the signal handler and the request below all race to
  // settle this future; the losers must not surface as unhandled rejections.
  closed.promise.catch(noopFn)
  probe?.emit('cli:start:start')

  const runtime = createServiceClient<
    RuntimeCommand,
    RuntimeEvent,
    RuntimeResult
  >('runtime', {
    probe,
    onEvent(event) {
      probe?.emit(`runtime:${event.type}`, event)
      if (event.type === 'stopped') closed.resolve()
      if (event.type === 'error') closed.reject(deserializeError(event.error))
    },
    onFailure(error) {
      closed.reject(error)
    },
  })

  controller.signal.addEventListener(
    'abort',
    () => {
      void runtime.stop().then(
        () => closed.resolve(),
        (error) => closed.reject(normalizeError(error)),
      )
    },
    { once: true },
  )

  try {
    await runtime.request({
      type: 'start',
      mode: 'production',
      outDir,
      manifestFile,
      runtimes: options.runtimes,
    })
    await closed.promise
    probe?.emit('cli:start:closed')
  } finally {
    controller.dispose()
    // The command is already returning: a failing second stop of an exited
    // service worker must not mask the original outcome.
    await runtime.stop().catch(noopFn)
  }
}
