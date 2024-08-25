import assert from 'node:assert'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TServiceContract } from '@nmtjs/contract'
import {
  type AnyGuard,
  type AnyMiddleware,
  type AnyProcedure,
  Procedure,
} from './api.ts'
import { Hook } from './constants.ts'
import { Hooks } from './hooks.ts'
import type { HooksInterface } from './types.ts'

export interface ServiceLike<
  Contract extends TServiceContract = TServiceContract,
> {
  contract: Contract
  procedures: Map<string, AnyProcedure>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  hooks: Hooks
}

export type AnyService = ServiceLike<TServiceContract>

export class Service<Contract extends TServiceContract = TServiceContract> {
  constructor(public readonly contract: Contract) {}

  procedures = new Map<string, AnyProcedure>()
  guards = new Set<AnyGuard>()
  middlewares = new Set<AnyMiddleware>()
  hooks = new Hooks()

  implement<K extends Extract<keyof Contract['procedures'], string>>(
    name: K,
    implementaion: AnyProcedure<Contract['procedures'][K]>,
  ) {
    this.procedures.set(name, implementaion)
    return this
  }

  withHook<T extends Hook>(hook: T, handler: HooksInterface[T]) {
    this.hooks.add(hook, handler)
    return this
  }

  withAutoload(directory: string | URL) {
    const dirpath =
      directory instanceof URL ? fileURLToPath(directory) : directory
    this.hooks.add(
      Hook.BeforeInitialize,
      autoLoader(path.resolve(dirpath), this),
    )
    return this
  }

  withGuard(guard: AnyGuard) {
    this.guards.add(guard)
    return this
  }

  withMiddleware(middleware: AnyMiddleware) {
    this.middlewares.add(middleware)
    return this
  }
}

const autoLoader = (directory: string, service: Service<any>) => async () => {
  const procedureNames = Object.keys(service.contract.procedures)
  const extensions = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']
  const ignore = ['.d.ts', '.d.mts', '.d.cts']
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (ignore.some((ext) => entry.name.endsWith(ext))) continue
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
    const procedureName = path.parse(
      path.join(entry.parentPath, entry.name),
    ).name
    if (!procedureNames.includes(procedureName)) continue
    const filepath = path.join(entry.parentPath, entry.name)
    let implementation: any = null
    // TODO: this might be not very reliable
    if (typeof module === 'undefined') {
      implementation = await import(filepath).then((m) => m.default)
    } else {
      implementation = require(filepath)
    }
    assert(implementation instanceof Procedure, 'Invalid procedure')
    service.implement(procedureName, implementation as any)
  }
}
