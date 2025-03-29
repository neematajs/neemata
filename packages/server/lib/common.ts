import EventEmitter from 'node:events'
import { type ApplicationWorkerOptions, WorkerType } from '@nmtjs/application'

export const bindPortMessageHandler = (port: EventEmitter) => {
  port.on('message', (message) => {
    if (message && typeof message === 'object') {
      const { type, payload } = message
      if (typeof type === 'string') {
        port.emit(type, payload)
      }
    }
  })
}

export const createBroadcastChannel = (name: string) => {
  const channel = new BroadcastChannel(name)
  const emitter = new EventEmitter()
  channel.onmessageerror = console.error
  channel.onmessage = (message) => {
    // @ts-ignore
    emitter.emit('message', message.data)
  }
  bindPortMessageHandler(emitter)
  const close = () => {
    channel.close()
    emitter.removeAllListeners()
  }
  const postMessage = (message: any) => channel.postMessage(message)

  return Object.assign(emitter, { close, postMessage })
}

export enum WorkerMessageType {
  Ready = 'Ready',
  Start = 'Start',
  Stop = 'Stop',
  ExecuteInvoke = 'ExecuteInvoke',
  ExecuteResult = 'ExecuteResult',
  ExecuteAbort = 'ExecuteAbort',
}
