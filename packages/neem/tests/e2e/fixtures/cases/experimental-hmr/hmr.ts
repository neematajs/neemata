import type {
  NeemRuntimeHmrAdapter,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'

import type { hmrValue } from './hmr-value.ts'
import { record } from '../../shared/support/_events.ts'
import { ExperimentalHmrRuntime } from './runtime.ts'

type Definition = typeof hmrValue

class ReloadableExperimentalHmrRuntime extends ExperimentalHmrRuntime {
  constructor(
    private readonly hmrContext: NeemRuntimeWorkerContext<
      { label: string },
      Definition
    >,
  ) {
    super(hmrContext)
  }

  apply(next: Definition) {
    if (next.reject) throw new Error(`rejected ${next.marker}`)
    record({
      event: 'experimental-hmr-applied',
      marker: next.marker,
      name: this.hmrContext.name,
    })
  }
}

export const experimentalHmrAdapter: NeemRuntimeHmrAdapter<
  { label: string },
  Definition
> = {
  createRuntime(_worker, ctx) {
    return new ReloadableExperimentalHmrRuntime(ctx)
  },
  apply(runtime, _current, next) {
    if (!(runtime instanceof ReloadableExperimentalHmrRuntime)) {
      return { accepted: false, reason: 'Unexpected fixture runtime' }
    }
    runtime.apply(next.definition)
    return { accepted: true }
  },
}
