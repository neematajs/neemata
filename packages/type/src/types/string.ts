import { type StringOptions, type TString, Type } from '@sinclair/typebox'
import { BaseType, type ConstantType, type TypeParams } from './base.ts'

export class StringType extends BaseType<TString, { options: StringOptions }> {
  declare _: ConstantType<TString>

  static factory(options: StringOptions = {}) {
    return new StringType(Type.String(options), { options })
  }

  max(value: number) {
    return StringType.factory({
      ...this.props.options,
      maxLength: value,
    })
  }

  min(value: number) {
    return StringType.factory({
      ...this.props.options,
      minLength: value,
    })
  }

  format(format: TString['format']) {
    return StringType.factory({
      ...this.props.options,
      pattern: undefined,
      format,
    })
  }

  pattern(pattern: string) {
    return StringType.factory({
      ...this.props.options,
      format: undefined,
      pattern,
    })
  }

  email() {
    return this.format('email')
  }

  url() {
    return this.format('uri')
  }

  ipv4() {
    return this.format('ipv4')
  }

  ipv6() {
    return this.format('ipv6')
  }

  uuid() {
    return this.format('uuid')
  }
}
