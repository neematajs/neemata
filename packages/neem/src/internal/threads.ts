import type { MessagePort } from 'node:worker_threads'

// How long a worker thread gets to exit on its own before it is terminated.
export const STOP_TIMEOUT_MS = 5_000

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function getRequestTimeoutMs(value: string | undefined): number {
  const timeoutMs = Number.parseInt(value ?? '', 10)
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS
}

// Closing a port drops queued deliveries, and process.exit() gives pending I/O
// no chance to flush, so the already-posted reply needs one macrotask to reach
// the parent before this thread goes away.
export async function closeAndExit(
  ...ports: readonly MessagePort[]
): Promise<never> {
  for (const port of ports) port.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  process.exit(0)
}
