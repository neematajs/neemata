import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

export type SpawnedProcess = {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  waitForExit: () => Promise<{ code: number | null; signal: string | null }>
  stop: () => Promise<void>
}

export async function waitFor<T>(
  poll: () => T | false | undefined | Promise<T | false | undefined>,
  timeoutMs: number,
  onTimeoutContext: () => string,
): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await poll()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms\n${onTimeoutContext()}`, {
    cause: lastError,
  })
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a local TCP port'))
        return
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      )
    })
  })
}

export function spawnWithCapture(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): SpawnedProcess {
  let stdout = ''
  let stderr = ''
  let state: { code: number | null; signal: string | null } | undefined
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        state = { code, signal }
        resolveExit(state)
      })
    },
  )
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForExit: () => exit,
    async stop() {
      if (!state) child.kill('SIGTERM')
      const graceful = await Promise.race([
        exit.then(() => true),
        new Promise<false>((resolveTimeout) =>
          setTimeout(() => resolveTimeout(false), 2_000),
        ),
      ])
      if (!graceful && !state) child.kill('SIGKILL')
      await exit
    },
  }
}
