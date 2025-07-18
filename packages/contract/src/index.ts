// biome-ignore lint/correctness/noUnusedImports: TSC wants it
import t from '@nmtjs/type'

import { APIContract } from './schemas/api.ts'
import { EventContract } from './schemas/event.ts'
import { NamespaceContract } from './schemas/namespace.ts'
import { ProcedureContract } from './schemas/procedure.ts'
import { SubscriptionContract } from './schemas/subscription.ts'
import { BlobType } from './types/blob.ts'

export * from './schemas/api.ts'
export * from './schemas/event.ts'
export * from './schemas/namespace.ts'
export * from './schemas/procedure.ts'
export * from './schemas/subscription.ts'

export namespace contract {
  export const procedure = ProcedureContract
  export const event = EventContract
  export const subscription = SubscriptionContract
  export const namespace = NamespaceContract
  export const api = APIContract
  export const blob = BlobType
}

export { contract as c }

export default contract
