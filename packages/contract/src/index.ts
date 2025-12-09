import { EventContract } from './schemas/event.ts'
import { ProcedureContract } from './schemas/procedure.ts'
import { RouterContract } from './schemas/router.ts'
import { SubscriptionContract } from './schemas/subscription.ts'
import { BlobType } from './types/blob.ts'

export * from './schemas/event.ts'
export * from './schemas/procedure.ts'
export * from './schemas/router.ts'
export * from './schemas/subscription.ts'

export namespace contract {
  export const procedure = ProcedureContract
  export const event = EventContract
  export const subscription = SubscriptionContract
  export const router = RouterContract
  export const blob = BlobType
}

export { contract as c }

export default contract
