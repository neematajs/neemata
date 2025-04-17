import {
  type core,
  email,
  ipv4,
  ipv6,
  maxLength,
  minLength,
  regex,
  string,
  url,
  uuid,
  type ZodMiniString,
} from '@zod/mini'

import { BaseType } from './base.ts'

type Check = core.CheckFn<string> | core.$ZodCheck<string>

export class StringType extends BaseType<
  ZodMiniString<string>,
  ZodMiniString<string>,
  { checks: Check[] }
> {
  static factory(...checks: Check[]) {
    return new StringType({
      encodedZodType: string().check(...checks),
      props: { checks },
    })
  }

  max(value: number) {
    return StringType.factory(...this.props.checks, maxLength(value))
  }

  min(value: number) {
    return StringType.factory(...this.props.checks, minLength(value))
  }

  pattern(pattern: string | RegExp) {
    return StringType.factory(
      ...this.props.checks,
      regex(typeof pattern === 'string' ? new RegExp(pattern) : pattern),
    )
  }

  email(options?: core.$ZodEmailParams) {
    return StringType.factory(...this.props.checks, email(options))
  }

  url(options?: core.$ZodURLParams) {
    return StringType.factory(...this.props.checks, url(options))
  }

  ipv4(options?: core.$ZodIPv4Params) {
    return StringType.factory(...this.props.checks, ipv4(options))
  }

  ipv6(options?: core.$ZodIPv6Params) {
    return StringType.factory(...this.props.checks, ipv6(options))
  }

  uuid(options?: core.$ZodUUIDParams) {
    return StringType.factory(...this.props.checks, uuid(options))
  }
}
