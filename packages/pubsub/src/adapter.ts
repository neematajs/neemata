export type PubSubMessage = {
  channel: string
  data: { event: string; payload: unknown }
}

export interface PubSubAdapter {
  publish(channel: string, payload: unknown): Promise<boolean>
  /**
   * Resolves once the broker delivers the channel's messages, so a message
   * published after it resolves reaches the returned iterable. Aborting the
   * signal or leaving the iteration releases the subscription.
   */
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<PubSubMessage>>
}
