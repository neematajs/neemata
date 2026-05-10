import type { NeemApp } from '@nmtjs/neem'
import { defineApp } from '@nmtjs/neem'

import type { ApplicationConfig, ApplicationTransport } from './config.ts'

export type NeemataAppThreadOptions<
  TApplication extends ApplicationConfig<any, any>,
> =
  TApplication extends ApplicationConfig<any, infer Transports>
    ? {
        [K in keyof Transports]: Transports[K] extends ApplicationTransport<
          any,
          infer Options
        >
          ? Options
          : never
      }
    : never

export type NeemataApp<
  TApplication extends ApplicationConfig<any, any> = ApplicationConfig<
    any,
    any
  >,
> = NeemApp<NeemataAppThreadOptions<TApplication>, TApplication>

export function defineNeemataApp<
  const TApplication extends ApplicationConfig<any, any>,
>(application: TApplication): NeemataApp<TApplication> {
  return defineApp<NeemataAppThreadOptions<TApplication>, TApplication>({
    kind: 'neemata',
    definition: application,
    createRuntime() {
      throw new Error('Neemata app runtime is not wired yet.')
    },
  })
}
