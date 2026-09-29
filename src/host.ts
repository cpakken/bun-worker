import type { SerializedError, WorkerCall, WorkerReply } from './protocol'
import { prepareResult } from './transfer'

declare const self: Worker

/**
 * Serves a module's exported functions, one call at a time. The listener is attached before the
 * module loads, so calls sent while it initializes (such as WASM setup) wait instead of being lost.
 */
export function serve(loadModule: () => Promise<Record<string, unknown>>) {
  const loadedModule = loadModule()
  // A load failure rejects each call below; don't also report it as unhandled.
  loadedModule.catch(() => {})
  let queue = Promise.resolve()

  self.onmessage = (event: MessageEvent<WorkerCall>) => {
    const call = event.data
    queue = queue.then(() => handle(call))
  }

  async function handle({ id, method, args }: WorkerCall) {
    try {
      const exported = (await loadedModule)[method]
      if (typeof exported !== 'function') {
        throw new TypeError(`The worker module has no exported function "${method}".`)
      }
      const result = prepareResult(await exported(...args))
      self.postMessage({ id, ok: true, value: result.value } satisfies WorkerReply, result.transfer)
    } catch (error) {
      self.postMessage({ id, ok: false, error: serializeError(error) } satisfies WorkerReply)
    }
  }
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return { name: error.name, message: error.message, stack: error.stack }
}
