import { setTimeout } from 'node:timers/promises'

export async function poll<T>(
  operation: () => Promise<T>,
  options: {
    timeoutMs?: number
    intervalMs?: number
    condition: (value: T) => boolean
    description: string
  },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20000
  const intervalMs = options.intervalMs ?? 200
  const startedAt = Date.now()
  let lastValue: T | undefined

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await operation()
    if (options.condition(lastValue)) return lastValue
    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for ${options.description}. Last value: ${JSON.stringify(lastValue)}`,
  )
}
