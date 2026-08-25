import { appendFileSync } from 'node:fs'

export function record(event: Record<string, unknown>): void {
  appendFileSync(
    process.env.NEEM_RUNTIME_EVENTS_FILE!,
    `${JSON.stringify(event)}\n`,
  )
}
