import { Registry } from '@nmtjs/core'
import type { BaseType, BaseTypeAny } from '@nmtjs/type'
import { type Compiled, compile } from '@nmtjs/type/compiler'

export class ProtocolRegistry extends Registry {
  readonly types = new Set<BaseType>()
  readonly compiled = new Map<any, Compiled>()

  registerType(type: BaseTypeAny) {
    this.types.add(type)
  }

  compile() {
    for (const type of this.types) {
      this.compiled.set(type, compile(type))
    }
  }

  clear() {
    super.clear()
    this.types.clear()
    this.compiled.clear()
  }
}
