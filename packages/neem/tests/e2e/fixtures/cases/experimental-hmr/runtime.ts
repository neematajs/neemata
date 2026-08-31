import type { NeemRuntime, NeemRuntimeWorkerContext } from '@nmtjs/neem'

import type { hmrValue } from './hmr-value.ts'
import { record } from '../../shared/support/_events.ts'

type Definition = typeof hmrValue

export class ExperimentalHmrRuntime implements NeemRuntime {
  constructor(
    private readonly ctx: NeemRuntimeWorkerContext<
      { label: string },
      Definition
    >,
  ) {}

  start() {
    record({
      event: 'experimental-hmr-start',
      marker: this.ctx.definition.marker,
      name: this.ctx.name,
    })
    return undefined
  }

  stop() {
    record({ event: 'experimental-hmr-stop', name: this.ctx.name })
  }
}
