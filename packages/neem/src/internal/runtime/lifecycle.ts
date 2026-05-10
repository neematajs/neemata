export type NeemHostLifecycleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reloading'
  | 'failed'
  | 'stopping'
  | 'stopped'

export type NeemHostLifecycleToken = { revision: number }

export type NeemHostLifecycleSnapshot = {
  state: NeemHostLifecycleState
  revision: number
  lastError?: Error
}

export class NeemHostLifecycle {
  private state: NeemHostLifecycleState = 'idle'
  private revision = 0
  private lastError: Error | undefined

  getState(): NeemHostLifecycleState {
    return this.state
  }

  getSnapshot(): NeemHostLifecycleSnapshot {
    return {
      state: this.state,
      revision: this.revision,
      lastError: this.lastError,
    }
  }

  markStarting(): NeemHostLifecycleToken {
    return this.transition('starting')
  }

  beginReload(): NeemHostLifecycleToken {
    return this.transition('reloading')
  }

  markRunning(token?: NeemHostLifecycleToken): boolean {
    return this.transitionIfCurrent('running', token)
  }

  markFailed(error: Error, token?: NeemHostLifecycleToken): boolean {
    if (!this.isCurrent(token)) return false
    this.lastError = error
    this.state = 'failed'
    return true
  }

  markStopping(): NeemHostLifecycleToken {
    return this.transition('stopping')
  }

  markStopped(token?: NeemHostLifecycleToken): boolean {
    return this.transitionIfCurrent('stopped', token)
  }

  private transition(state: NeemHostLifecycleState): NeemHostLifecycleToken {
    this.revision += 1
    this.state = state
    if (state !== 'failed') {
      this.lastError = undefined
    }
    return { revision: this.revision }
  }

  private transitionIfCurrent(
    state: NeemHostLifecycleState,
    token?: NeemHostLifecycleToken,
  ): boolean {
    if (!this.isCurrent(token)) return false
    this.state = state
    if (state !== 'failed') {
      this.lastError = undefined
    }
    return true
  }

  private isCurrent(token: NeemHostLifecycleToken | undefined): boolean {
    return !token || token.revision === this.revision
  }
}
