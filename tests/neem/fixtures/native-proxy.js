function state() {
  return globalThis.__neemNativeProxyTestState ?? {}
}

class NeemTestProxy {
  constructor(options) {
    state().options?.push(options)
  }

  async start() {
    state().operations?.push('start')
    if (state().startError) throw new Error(state().startError)
  }

  async stop() {
    state().operations?.push('stop')
    if (state().stopError) throw new Error(state().stopError)
  }

  async addUpstream(runtimeName, upstream) {
    state().operations?.push(`add:${runtimeName}:${upstream.port}`)
    if (state().addError) throw new Error(state().addError)
  }

  async removeUpstream(runtimeName, upstream) {
    if (state().removeDelayMs) await wait(state().removeDelayMs)
    state().operations?.push(`remove:${runtimeName}:${upstream.port}`)
    if (state().removeError) throw new Error(state().removeError)
  }
}

export { NeemTestProxy as Proxy }

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
