export type PubSubMessage<Payload = unknown> = {
  channel: string
  payload: Payload
}

export interface PubSubAdapter {
  publish(channel: string, payload: unknown): Promise<boolean>
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubMessage>
  initialize(): Promise<void>
  dispose(): Promise<void>
}
