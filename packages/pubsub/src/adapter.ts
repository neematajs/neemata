export type PubSubMessage = {
  channel: string
  data: { event: string; payload: unknown }
}

export interface PubSubAdapter {
  publish(channel: string, payload: unknown): Promise<boolean>
  subscribe(channel: string, signal?: AbortSignal): AsyncIterable<PubSubMessage>
}
