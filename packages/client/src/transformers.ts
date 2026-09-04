import type { MaybePromise } from '@nmtjs/common'

export class BaseClientTransformer {
  encode(_procedure: string, payload: any): MaybePromise<any> {
    return payload
  }
  decode(_procedure: string, payload: any): MaybePromise<any> {
    return payload
  }
}
