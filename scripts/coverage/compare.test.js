import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareCoverage, renderSummary } from './compare.js'
import { mergeCoverageMaps, summarizeCoverage } from './run.js'

void test('merges hits from separate runs by source location', () => {
  const unit = {
    '/repo/src/a.ts': {
      path: '/repo/src/a.ts',
      statementMap: { 0: loc(1, 0), 1: loc(2, 0), 2: loc(2, 10) },
      s: { 0: 1, 1: 0, 2: 0 },
      fnMap: { 0: { loc: loc(1, 0) } },
      f: { 0: 0 },
      branchMap: { 0: { loc: loc(2, 0) } },
      b: { 0: [1, 0] },
    },
  }
  // A differently configured project numbers the same locations differently.
  const integration = {
    '/repo/src/a.ts': {
      path: '/repo/src/a.ts',
      statementMap: { 0: loc(2, 10), 1: loc(2, 0), 2: loc(1, 0) },
      s: { 0: 0, 1: 3, 2: 0 },
      fnMap: { 0: { loc: loc(1, 0) } },
      f: { 0: 2 },
      branchMap: { 0: { loc: loc(2, 0) } },
      b: { 0: [0, 1] },
    },
  }

  const summaries = summarizeCoverage(mergeCoverageMaps([unit, integration]))

  assert.deepEqual(summaries.get('/repo/src/a.ts'), {
    lines: { covered: 2, total: 2 },
    branches: { covered: 2, total: 2 },
    functions: { covered: 1, total: 1 },
    statements: { covered: 2, total: 3 },
  })
})

void test('renders package deltas and lists files with dropped coverage first', () => {
  const base = report('base', {
    'packages/a/src/x.ts': file('@nmtjs/a', [8, 10]),
    'packages/a/src/y.ts': file('@nmtjs/a', [5, 10]),
    'packages/b/src/z.ts': file('@nmtjs/b', [10, 10]),
    'packages/b/src/removed.ts': file('@nmtjs/b', [0, 4]),
  })
  const head = report('head', {
    'packages/a/src/x.ts': file('@nmtjs/a', [6, 10]),
    'packages/a/src/y.ts': file('@nmtjs/a', [9, 10]),
    'packages/b/src/z.ts': file('@nmtjs/b', [10, 10]),
    'packages/b/src/new.ts': file('@nmtjs/b', [3, 4]),
  })

  const comparison = compareCoverage({ base, head })
  const summary = renderSummary(comparison)

  assert.deepEqual(
    comparison.files.map((entry) => entry.path),
    [
      'packages/b/src/removed.ts',
      'packages/a/src/x.ts',
      'packages/a/src/y.ts',
      'packages/b/src/new.ts',
    ],
  )
  assert.match(summary, /^# Coverage report/)
  assert.match(summary, /Base `base000` → head `head000`/)
  assert.match(summary, /\| @nmtjs\/a \| 75\.00% \(▲ 10\.00\) \|/)
  assert.match(summary, /\| @nmtjs\/b \| 92\.86% \(▲ 21\.43\) \|/)
  assert.match(summary, /\| packages\/a\/src\/x\.ts \| 60\.00% \(▼ 20\.00\) \|/)
  assert.match(summary, /packages\/b\/src\/removed\.ts \(removed\)/)
  assert.match(summary, /packages\/b\/src\/new\.ts \(new\) \| 75\.00% \|/)
  assert.doesNotMatch(summary, /z\.ts/)
})

void test('renders a baseline without deltas when no base exists', () => {
  const head = report('head', {
    'packages/a/src/x.ts': file('@nmtjs/a', [1, 2]),
  })

  const summary = renderSummary(compareCoverage({ head }))

  assert.match(summary, /^# Coverage baseline/)
  assert.match(summary, /No base revision is available/)
  assert.match(summary, /\| @nmtjs\/a \| 50\.00% \|/)
  assert.doesNotMatch(summary, /Files with changed coverage/)
})

void test('flags runs that failed or were skipped', () => {
  const head = report(
    'head',
    { 'packages/a/src/x.ts': file('@nmtjs/a', [1, 2]) },
    [
      { name: 'unit', status: 'failed' },
      { name: 'pubsub-integration', status: 'skipped' },
    ],
  )

  const summary = renderSummary(compareCoverage({ head }))

  assert.match(summary, /head `unit` had failing tests/)
  assert.match(summary, /head `pubsub-integration` was skipped/)
})

function loc(line, column) {
  return { start: { line, column }, end: { line, column: column + 5 } }
}

function report(commit, files, runs = [{ name: 'unit', status: 'passed' }]) {
  return {
    schemaVersion: 1,
    commit: `${commit}0000000`,
    runs,
    files,
  }
}

function file(name, [covered, total]) {
  const counts = { covered, total }
  return {
    package: name,
    lines: counts,
    branches: counts,
    functions: counts,
    statements: counts,
  }
}
