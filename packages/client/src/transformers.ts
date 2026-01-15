export class BaseClientTransformer {
  encode(_procedure: string, payload: any) {
    return payload
  }
  decode(_procedure: string, payload: any) {
    return payload
  }
}
