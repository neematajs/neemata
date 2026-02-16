import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export const E2E_CWD = resolve(import.meta.dirname, '../..')
export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const DEFAULT_SERVER_PORT = 4000

export type NeemataCommand = 'dev' | 'preview' | 'build'

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const cleanup = () => {
      socket.removeAllListeners()
      socket.destroy()
    }

    socket.setTimeout(500)
    socket.once('connect', () => {
      cleanup()
      resolve(true)
    })
    socket.once('timeout', () => {
      cleanup()
      resolve(false)
    })
    socket.once('error', () => {
      cleanup()
      resolve(false)
    })
  })
}

export async function startNeemataCliServer(options: {
  command: NeemataCommand
  cwd?: string
  configPath?: string
  timeoutMs?: number
  startupDelayMs?: number
  host?: string
  port?: number
}): Promise<ChildProcess> {
  const {
    command,
    cwd = E2E_CWD,
    configPath,
    timeoutMs = 15000,
    startupDelayMs = 1000,
    host = DEFAULT_SERVER_HOST,
    port = DEFAULT_SERVER_PORT,
  } = options

  const args = ['exec', 'neemata', command]
  if (configPath) args.push('--config', configPath)

  const serverProcess = spawn('pnpm', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'linux',
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  serverProcess.stdout?.on('data', () => {})
  serverProcess.stderr?.on('data', () => {})

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    const timeoutId = globalThis.setTimeout(() => {
      finish(new Error(`Server startup timeout (${command})`))
    }, timeoutMs)

    const readinessInterval = globalThis.setInterval(() => {
      canConnect(host, port).then((ready) => {
        if (ready) finish()
      })
    }, 250)

    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => {
      finish(new Error(`Server exited before readiness (code ${code})`))
    }

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId)
      globalThis.clearInterval(readinessInterval)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
    }

    serverProcess.on('error', onError)
    serverProcess.on('exit', onExit)
  })

  await setTimeout(startupDelayMs)

  return serverProcess
}

export async function waitForPortReady(options: {
  host?: string
  port?: number
  timeoutMs?: number
}): Promise<void> {
  const {
    host = DEFAULT_SERVER_HOST,
    port = DEFAULT_SERVER_PORT,
    timeoutMs = 15000,
  } = options

  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const ready = await canConnect(host, port)

    if (ready) return

    await setTimeout(250)
  }

  throw new Error(`Server startup timeout (${host}:${port})`)
}

export async function waitForPortClosed(options: {
  host?: string
  port?: number
  timeoutMs?: number
}): Promise<void> {
  const {
    host = DEFAULT_SERVER_HOST,
    port = DEFAULT_SERVER_PORT,
    timeoutMs = 5000,
  } = options

  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const open = await canConnect(host, port)
    if (!open) return
    await setTimeout(100)
  }

  throw new Error(`Server did not release port in time (${host}:${port})`)
}

export async function stopServerProcess(
  serverProcess: ChildProcess,
): Promise<void> {
  const killProcess = (signal: NodeJS.Signals) => {
    const pid = serverProcess.pid

    if (!pid) return

    if (process.platform === 'linux') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall through to direct process kill
      }
    }

    try {
      serverProcess.kill(signal)
    } catch {
      // Ignore if process already exited
    }
  }

  killProcess('SIGTERM')
  await new Promise<void>((resolve) => {
    serverProcess.on('exit', () => resolve())
    globalThis.setTimeout(() => {
      killProcess('SIGKILL')
      resolve()
    }, 5000)
  })
}
