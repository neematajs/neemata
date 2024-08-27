import { EventEmitter, type EventMap } from './utils.ts'

export class Subscription<
  Events extends EventMap = EventMap,
> extends EventEmitter<Events> {
  constructor(
    readonly key: string,
    readonly unsubscribe: () => void,
  ) {
    super()
  }
}
