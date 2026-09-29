import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SerializedError, WorkerCall, WorkerReply } from './protocol'
import { argumentTransfers } from './transfer'

/** Bun's Worker can stop holding the process open while idle. */
type BunWorker = Worker & { ref(): void; unref(): void }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

type WorkerClient = {
  proxy: object
  /** Replaces the worker once no calls are pending, so the next call loads fresh code. */
  restart: () => void
}

// One client per worker module for the whole process. Vite's dev server re-evaluates calling
// modules after changes and loads this file as more than one module instance, so clients live here.
const clientsKey: unique symbol = Symbol.for('bun-worker.clients')
const processState = globalThis as { [clientsKey]?: Map<string, WorkerClient> }
const clients = (processState[clientsKey] ??= new Map())

/** Returns the call proxy for a worker, creating its client on first use. */
export function workerModule(key: string, name: string, createWorker: () => Worker) {
  let client = clients.get(key)
  if (!client) clients.set(key, (client = createClient(name, createWorker)))
  return client.proxy
}

/**
 * Locates a built worker. The bundler's path is relative to the calling module, but Nitro and
 * standalone compilers move the output: they place workers beside the server modules, which
 * changes the relative path for modules that weren't already there (such as the server entry).
 */
export function builtWorkerUrl(relativePath: string, moduleUrl: string) {
  const bundled = new URL(relativePath, moduleUrl)
  if (existsSync(fileURLToPath(bundled))) return bundled.href
  return new URL(path.basename(relativePath), moduleUrl).href
}

/** Restarts every worker; the dev server calls this when source files change. */
export function restartWorkers() {
  for (const client of clients.values()) client.restart()
}

function createClient(name: string, createWorker: () => Worker): WorkerClient {
  let worker: BunWorker | undefined
  let restartPending = false
  let nextId = 1
  const pending = new Map<number, Pending>()

  function call(method: string, args: unknown[]) {
    const target = worker ?? startWorker()
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      target.ref()
      try {
        target.postMessage({ id, method, args } satisfies WorkerCall, argumentTransfers(args))
      } catch (error) {
        pending.delete(id)
        releaseIfIdle()
        reject(error)
      }
    })
  }

  function startWorker() {
    const started = createWorker() as BunWorker
    worker = started
    // Keep the process alive only while calls are pending.
    started.unref()
    started.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (started === worker) settle(event.data)
    }
    started.onerror = (event) => {
      if (started !== worker) return
      event.preventDefault()
      fail(new Error(event.message || `The Bun worker "${name}" stopped unexpectedly.`))
    }
    started.addEventListener('close', () => {
      if (started === worker) fail(new Error(`The Bun worker "${name}" exited unexpectedly.`))
    })
    return started
  }

  function settle(reply: WorkerReply) {
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id)
    releaseIfIdle()
    if (reply.ok) request.resolve(reply.value)
    else request.reject(toError(reply.error))
  }

  function fail(error: Error) {
    stopWorker()
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  function releaseIfIdle() {
    if (pending.size > 0) return
    worker?.unref()
    if (restartPending) stopWorker()
  }

  function stopWorker() {
    const stopping = worker
    worker = undefined
    restartPending = false
    stopping?.terminate()
  }

  const proxy = new Proxy(
    {},
    {
      get(_, method) {
        // `then` stays undefined so the proxy isn't mistaken for a promise.
        if (typeof method !== 'string' || method === 'then') return undefined
        return (...args: unknown[]) => call(method, args)
      },
    }
  )

  return {
    proxy,
    restart() {
      if (!worker) return
      restartPending = true
      releaseIfIdle()
    },
  }
}

function toError({ name, message, stack }: SerializedError) {
  const error = new Error(message)
  error.name = name
  if (stack) error.stack = stack
  return error
}
