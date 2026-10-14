import type { MessagePort } from 'node:worker_threads'

import type { NeemWorkerErrorOrigin } from '@nmtjs/neem/internal/shared/errors'
import type { Logger } from 'pino'
import { flushLogger } from '@nmtjs/neem/internal/logger'
import { serializeError } from '@nmtjs/neem/internal/utils'

import type { FatalFrame } from './protocol.ts'
import { FATAL_FRAME } from './protocol.ts'

// What an exit without a budget from the host gets to flush, e.g. a crash:
// enough for a best-effort flush without holding up the failure.
const CRASH_FLUSH_MS = 1_000

/**
 * The way out of a worker isolate: report a failure synchronously, close the
 * ports, flush the logger within the host's budget, exit. The first exit wins.
 */
export class WorkerExit {
  private exiting: Promise<never> | undefined
  private readonly parent: MessagePort
  private readonly onClose: () => void
  logger: Logger | undefined

  constructor(parent: MessagePort | null, onClose: () => void = () => {}) {
    if (!parent) throw new Error('Neem worker entry requires a parent port')
    this.parent = parent
    this.onClose = onClose
  }

  /**
   * Posts the failure before anything else can run: the host learns why the
   * worker goes away even if the exit follows immediately.
   */
  reportFatal(value: unknown, origin: NeemWorkerErrorOrigin, label: string) {
    // This thread is the only place the real value still exists, so it is
    // logged here in full; the host receives a rendered summary.
    if (value instanceof Error) {
      this.logger?.error(
        new Error(`${label} ${origin} error`, { cause: value }),
      )
    } else {
      this.logger?.error({ err: value }, `${label} ${origin} error`)
    }
    if (this.exiting) return
    const frame: FatalFrame = [
      FATAL_FRAME,
      { ...serializeError(value), origin },
    ]
    this.parent.postMessage(frame)
  }

  exit(code: number, timeoutMs = CRASH_FLUSH_MS): Promise<never> {
    return (this.exiting ??= (async () => {
      this.onClose()
      try {
        if (this.logger) await flushLogger(this.logger, timeoutMs)
      } catch {
        // The exit goes ahead regardless; there is nobody left to report to.
      }
      // Lets the parent port deliver what was posted before the exit.
      await new Promise<void>((resolve) => setImmediate(resolve))
      process.exit(code)
    })())
  }

  /** Reports uncaught failures of the isolate as fatal and exits. */
  installCrashHandlers(label: string): void {
    process.on('uncaughtException', (error) => {
      this.reportFatal(error, 'runtime', label)
      void this.exit(1)
    })
    process.on('unhandledRejection', (error) => {
      this.reportFatal(error, 'runtime', label)
      void this.exit(1)
    })
  }
}
