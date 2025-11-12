import { createPromise, defer, noopFn, onAbort } from '@nmtjs/common'
import { Container, createValueInjectable } from '@nmtjs/core'
import { BaseType } from '@nmtjs/type'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Commands, createCommand } from '../src/commands.ts'
import { kCommand } from '../src/constants.ts'
import { LifecycleHooks } from '../src/lifecycle-hooks.ts'
import { ApplicationRegistry } from '../src/registry.ts'
import { testCommand, testDefaultTimeout, testLogger } from './_utils.ts'

describe('Command', () => {
  it('should create a command', () => {
    const command = createCommand('test', { handler: noopFn })

    expect(kCommand in command).toBe(true)
    expect(command).toHaveProperty('name', 'test')
    expect(command).toHaveProperty('handler', noopFn)
    expect(command).toHaveProperty('dependencies', {})
    expect(command).toHaveProperty('args', expect.any(BaseType))
    expect(command).toHaveProperty('kwargs', expect.any(BaseType))
  })

  it('should create a command with dependencies', () => {
    const dep1 = createValueInjectable('dep1')
    const dep2 = createValueInjectable('dep2')
    const command = createCommand('test', {
      handler: noopFn,
      dependencies: { dep1, dep2 },
    })

    expect(command.dependencies).toHaveProperty('dep1', dep1)
    expect(command.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create a command with a handler', () => {
    const handler = () => {}
    const command = createCommand('test', { handler })
    expect(command.handler).toBe(handler)
  })
})

describe('Commands', () => {
  const logger = testLogger()

  let registry: ApplicationRegistry
  let container: Container
  let commands: Commands
  let lifecycleHooks: LifecycleHooks

  beforeEach(async () => {
    lifecycleHooks = new LifecycleHooks()
    registry = new ApplicationRegistry({ logger })
    container = new Container({ logger, registry })
    commands = new Commands(
      { container, registry, lifecycleHooks },
      { timeout: testDefaultTimeout },
    )
    await container.initialize()
  })

  afterEach(async () => {
    await container.dispose()
  })

  it('should be a commands', () => {
    expect(commands).toBeDefined()
    expect(commands).toBeInstanceOf(Commands)
  })

  it('should execute a command', async () => {
    const command = testCommand({ handler: () => 'value' })
    registry.registerCommand(command)
    await expect(commands.execute(command, [])).resolves.toBe('value')
  })

  it('should inject context', async () => {
    const injectable = createValueInjectable({})
    const command = testCommand({
      dependencies: { dep: injectable },
      handler: (ctx) => ctx,
    })
    registry.registerCommand(command)
    await expect(commands.execute(command, [])).resolves.toHaveProperty(
      'dep',
      injectable.value,
    )
  })

  it('should handle errors', async () => {
    const thrownError = new Error('Test')
    const command = testCommand({
      handler: () => {
        throw thrownError
      },
    })
    registry.registerCommand(command)
    await expect(commands.execute(command, [])).rejects.toBe(thrownError)
  })

  it('should inject args', async () => {
    const args = ['arg1', 'arg2']
    const command = testCommand({ handler: (ctx, input) => input })
    registry.registerCommand(command)
    await expect(commands.execute(command, args)).resolves.toStrictEqual({
      args,
      kwargs: {},
    })
  })

  it('should call with abort signal', async () => {
    const future = createPromise<void>()
    const spy = vi.fn(future.resolve)
    const command = testCommand({
      handler: (_, __, signal) =>
        new Promise((_, reject) =>
          onAbort(signal, () => {
            spy()
            reject(new Error('Aborted'))
          }),
        ),
    })
    registry.registerCommand(command)
    const ac = new AbortController()
    const execution = commands.execute(command, [], {}, ac.signal)
    defer(() => ac.abort(), 10)
    await expect(execution).rejects.toBeInstanceOf(Error)
    expect(spy).toHaveBeenCalledOnce()
  })
})
