import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runPreviewCommand } from '../../src/internal/commands/cli.ts'

const hostMocks = vi.hoisted(() => ({
  loadRuntimeSnapshot: vi.fn(),
  runHostUntilClosed: vi.fn(),
}))

vi.mock('../../src/internal/host/bootstrap.ts', () => hostMocks)
vi.mock('../../src/internal/commands/preview.ts', () => ({
  runPreviewBuild: vi.fn(async () => true),
}))

const KEY = 'neem:source-maps'

// Bun applies its own maps; preview leaves its state alone there.
describe.skipIf(process.versions.bun)(
  'preview command source-map state',
  () => {
    const initial = process.sourceMapsEnabled

    beforeEach(() => {
      process.setSourceMapsEnabled(false)
      hostMocks.loadRuntimeSnapshot.mockResolvedValue({})
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      vi.clearAllMocks()
      setEnvironmentData(KEY, undefined)
      process.setSourceMapsEnabled(initial)
    })

    it('is restored when serving the preview fails', async () => {
      hostMocks.runHostUntilClosed.mockImplementation(async () => {
        expect(process.sourceMapsEnabled).toBe(true)
        throw new Error('runtime start failed')
      })

      await expect(
        runPreviewCommand({ config: 'neem.config.ts' }),
      ).rejects.toThrow('runtime start failed')
      expect(hostMocks.runHostUntilClosed).toHaveBeenCalledOnce()
      expect(process.sourceMapsEnabled).toBe(false)
      expect(getEnvironmentData(KEY)).toBeUndefined()
    })

    it('is restored when the served preview is cancelled', async () => {
      const controller = new AbortController()
      hostMocks.runHostUntilClosed.mockImplementation(
        (_snapshot, { signal }: { signal: AbortSignal }) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          ),
      )

      const running = runPreviewCommand(
        { config: 'neem.config.ts' },
        controller.signal,
      )
      await vi.waitFor(() =>
        expect(hostMocks.runHostUntilClosed).toHaveBeenCalledOnce(),
      )
      expect(process.sourceMapsEnabled).toBe(true)
      expect(getEnvironmentData(KEY)).toBe(true)
      controller.abort()
      await running
      expect(process.sourceMapsEnabled).toBe(false)
      expect(getEnvironmentData(KEY)).toBeUndefined()
    })

    it('stays off when the user turned source maps off', async () => {
      vi.stubEnv('NODE_OPTIONS', '--no-enable-source-maps')
      hostMocks.runHostUntilClosed.mockImplementation(async () => {
        expect(process.sourceMapsEnabled).toBe(false)
        expect(getEnvironmentData(KEY)).toBeUndefined()
      })

      await runPreviewCommand({ config: 'neem.config.ts' })
      expect(hostMocks.runHostUntilClosed).toHaveBeenCalledOnce()
    })
  },
)
