import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type { Program } from '../src/index.ts'
import * as Main from '../src/index.ts'
import { Client, settle, start } from '../src/index.ts'
import {
  caseKey,
  isTerminal,
  itemKey,
  memberKey,
  nodeUnits,
  parseChildKey,
  SELF,
  serializeWorkflowCatalog,
  TASK,
} from '../src/inspector.ts'
import { Billing } from './fixtures/billing.ts'
import { PROMISE_ENGINE } from './promise-engine.ts'
import {
  claimAttempts,
  completed,
  failed,
  pass,
  setup,
  unused,
  work,
} from './support.ts'

/** What a module loads when it runs: its imports that are not types alone. */
function loaded(file: string, seen = new Set<string>()): readonly string[] {
  if (seen.has(file)) return []
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  const specifiers = Array.from(
    source.matchAll(
      /^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'|^import\s+'([^']+)'/gms,
    ),
    ([, from, bare]) => (from ?? bare)!,
  )
  return specifiers.flatMap((specifier) =>
    specifier.startsWith('.')
      ? loaded(resolve(dirname(file), specifier), seen)
      : [specifier],
  )
}

describe('the inspector entry', () => {
  it('loads no Node API and no package, so a browser can load it', () => {
    const entry = resolve(import.meta.dirname, '../src/inspector.ts')
    expect(loaded(entry)).toStrictEqual([])
    // The same walk does find what the main entry hashes graphs with.
    expect(loaded(resolve(dirname(entry), 'graph/index.ts'))).toContain(
      'node:crypto',
    )
  })

  it('gives the catalog the Promise engine gave for the same declarations', () => {
    expect(
      serializeWorkflowCatalog({
        workflows: Billing.workflows,
        tasks: Billing.tasks,
      }),
    ).toStrictEqual(PROMISE_ENGINE.billing.catalog)
  })

  it.effect(
    'lists the children of a node, each with its attempts and its run',
    () => {
      const member = { kind: 'activity', execute: unused } as const
      const programs: readonly Program[] = [
        {
          kind: 'workflow',
          name: 'flow',
          steps: [
            {
              kind: 'parallel',
              name: 'both',
              members: {
                b: { ...member, input: () => 'b', retry: { attempts: 2 } },
                a: { ...member, input: () => 'a' },
              },
            },
            {
              kind: 'map',
              name: 'each',
              items: () => Array.from({ length: 11 }, (_, index) => index),
              input: (_outputs, _input, item) => item,
              target: { kind: 'task', task: { name: 'job' } },
            },
          ],
          result: () => null,
        },
        { kind: 'task', name: 'job', execute: unused },
      ]
      const { served, provide } = setup(programs)

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'flow', input: null })
          yield* pass(served)
          const claims = yield* claimAttempts(served)
          const of = (key: string) =>
            claims.find(({ command }) => command.childKey === memberKey(key))!
          expect(yield* settle(served, of('b'), failed('once'))).toBe(
            'retrying',
          )
          yield* settle(served, of('a'), completed('a'))
          yield* work(served, completed('b'))
          yield* pass(served)

          const detail = (yield* Client.getDetail(run.id))!
          // Handed over in no order of its own: the order is the list's.
          const unordered = {
            ...detail,
            children: [...detail.children].reverse(),
            attempts: [...detail.attempts].reverse(),
          }

          expect(nodeUnits(unordered, 'both')).toMatchObject([
            {
              key: 'member:a',
              parsed: { kind: 'member', memberKey: 'a' },
              child: { status: 'completed' },
              attempts: [{ attemptNumber: 1, status: 'completed' }],
            },
            {
              key: 'member:b',
              parsed: { kind: 'member', memberKey: 'b' },
              child: { status: 'completed' },
              attempts: [
                { attemptNumber: 1, status: 'failed' },
                { attemptNumber: 2, status: 'completed' },
              ],
            },
          ])

          // By the place of the item, which the text of a key does not give.
          const items = nodeUnits(unordered, 'each')
          expect(items.map(({ key }) => key)).toStrictEqual(
            Array.from({ length: 11 }, (_, index) => itemKey(index)),
          )
          for (const { child, childRun, attempts } of items) {
            expect(childRun).toMatchObject({
              id: child.childRunId,
              kind: 'task',
              name: 'job',
            })
            // The attempts of a task run are its own run's.
            expect(attempts).toStrictEqual([])
          }
          expect(nodeUnits(detail, 'absent')).toStrictEqual([])
        }),
      )
    },
  )
})

describe('the children of a node', () => {
  it.effect('are in the order the Promise engine listed keys in', () => {
    const member = { kind: 'activity', execute: unused, input: () => null }
    const { served, provide } = setup([
      {
        kind: 'workflow',
        name: 'flow',
        steps: [
          {
            kind: 'parallel',
            name: 'both',
            members: { z: member, ä: member, A: member, a: member },
          },
        ],
        result: () => null,
      } as Program,
    ])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: null })
        yield* pass(served)
        const detail = (yield* Client.getDetail(run.id))!

        // As text of a language is sorted, not by code unit: that would
        // be A, a, z, ä.
        expect(nodeUnits(detail, 'both').map(({ key }) => key)).toStrictEqual(
          ['a', 'A', 'ä', 'z'].map(memberKey),
        )
      }),
    )
  })
})

describe('what a dashboard reads a run by', () => {
  it.effect(
    'names the one node of a task run, and the statuses that end one',
    () => {
      const { served, provide } = setup([
        { kind: 'task', name: 'job', execute: unused },
      ])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
          const queued = (yield* Client.getDetail(run.id))!
          expect(queued.nodes.map(({ name }) => name)).toStrictEqual([TASK])
          expect(nodeUnits(queued, TASK)).toMatchObject([{ key: SELF }])
          expect(isTerminal(queued.run.status)).toBe(false)

          yield* work(served, completed('done'))
          expect(
            isTerminal((yield* Client.getDetail(run.id))!.run.status),
          ).toBe(true)
          // The main entry gives the same two.
          expect([Main.TASK, Main.isTerminal]).toStrictEqual([TASK, isTerminal])
        }),
      )
    },
  )
})

describe('child keys', () => {
  it('are read back as they were written', () => {
    expect(parseChildKey(SELF)).toStrictEqual({ kind: 'self' })
    // A key a user chose may hold anything, a prefix of ours included.
    expect(parseChildKey(caseKey('item:3'))).toStrictEqual({
      kind: 'case',
      caseKey: 'item:3',
    })
    expect(parseChildKey(memberKey(''))).toStrictEqual({
      kind: 'member',
      memberKey: '',
    })
    expect(parseChildKey(itemKey(12))).toStrictEqual({
      kind: 'item',
      itemIndex: 12,
    })
  })

  it('are not read from what the engine never wrote', () => {
    for (const key of ['self', 'item:', 'item:-1', 'item:01', 'item:1e2']) {
      expect(parseChildKey(key)).toBeUndefined()
    }
  })
})
