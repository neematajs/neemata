export class RpcManager {
  // connectionId:callId -> AbortController
  readonly rpcs = new Map<string, AbortController>()

  set(connectionId: string, callId: number, controller: AbortController) {
    const key = this.getKey(connectionId, callId)
    this.rpcs.set(key, controller)
  }

  get(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    return this.rpcs.get(key)
  }

  delete(connectionId: string, callId: number, owner?: AbortController) {
    const key = this.getKey(connectionId, callId)
    // callId may have been reused since — only remove an entry the caller owns
    if (owner && this.rpcs.get(key) !== owner) return
    this.rpcs.delete(key)
  }

  abort(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    // keep the reservation until the call's context is disposed, so the id
    // cannot be reused while an abort-ignoring handler is still running
    this.rpcs.get(key)?.abort()
  }

  close(connectionId: string) {
    // a connection sweep is rare (one per disconnect), so it scans rather
    // than maintaining a per-connection index
    for (const [key, controller] of this.rpcs) {
      if (key.startsWith(`${connectionId}:`)) {
        controller.abort()
        this.rpcs.delete(key)
      }
    }
  }

  private getKey(connectionId: string, callId: number) {
    return `${connectionId}:${callId}`
  }
}
