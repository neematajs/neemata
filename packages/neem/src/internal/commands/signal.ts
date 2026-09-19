export type SignalController = {
  signal: AbortSignal
  dispose: () => void
}

// Aborts on the first SIGINT/SIGTERM so a command can shut down gracefully,
// and detaches again so a second signal reaches Node's default handler.
export function createSignalController(): SignalController {
  const controller = new AbortController()
  const abort = () => controller.abort()

  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)

  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    },
  }
}
