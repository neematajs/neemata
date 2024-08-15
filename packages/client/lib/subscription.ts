import type { TSubscriptionContract } from '@nmtjs/contract'
import { EventEmitter } from './utils.ts'

export class Subscription<
  Contact extends TSubscriptionContract = TSubscriptionContract,
> extends EventEmitter<{
  [K in keyof Contact['events']]: [Contact['events'][K]['static']['payload']]
}> {
  constructor(
    readonly key: string,
    readonly unsubscribe: () => void,
  ) {
    super()
  }
}
