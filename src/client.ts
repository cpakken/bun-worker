import type { BunWorkerRequest, BunWorkerResponse, PreparedWorkerValue } from './protocol'

type PendingResult<TResult> = {
  resolve: (result: TResult) => void
  reject: (error: Error) => void
}

type BunWorkerClientOptions<TJob> = {
  createWorker: () => Worker
  stoppedMessage: string
  prepareJob?: (job: TJob) => PreparedWorkerValue<TJob>
}

/** Creates one lazy worker and correlates typed jobs with their eventual results. */
export function createBunWorkerClient<TJob, TResult>({
  createWorker,
  stoppedMessage,
  prepareJob,
}: BunWorkerClientOptions<TJob>) {
  let worker: Worker | undefined
  let workerReady = false
  let nextRequestId = 1
  const pendingResults = new Map<number, PendingResult<TResult>>()
  const queuedRequests: BunWorkerRequest<TJob>[] = []

  return function runInWorker(job: TJob): Promise<TResult> {
    const activeWorker = getWorker()
    const request = { id: nextRequestId++, job }

    return new Promise((resolve, reject) => {
      pendingResults.set(request.id, { resolve, reject })
      if (workerReady) sendRequest(activeWorker, request)
      else queuedRequests.push(request)
    })
  }

  function getWorker() {
    if (worker) return worker

    const newWorker = createWorker()
    worker = newWorker
    newWorker.onmessage = (event: MessageEvent<BunWorkerResponse<TResult>>) =>
      handleWorkerMessage(newWorker, event.data)
    newWorker.onerror = (event) => handleWorkerError(newWorker, event)
    return newWorker
  }

  function handleWorkerMessage(source: Worker, response: BunWorkerResponse<TResult>) {
    if (source !== worker) return

    if (response.status === 'ready') {
      workerReady = true
      for (const request of queuedRequests) sendRequest(source, request)
      queuedRequests.length = 0
      return
    }

    const pending = pendingResults.get(response.id)
    if (!pending) return

    pendingResults.delete(response.id)
    if (response.status === 'success') pending.resolve(response.result)
    else pending.reject(Object.assign(new Error(response.message), { name: response.name }))
  }

  function handleWorkerError(source: Worker, event: ErrorEvent) {
    if (source !== worker) return

    const error = new Error(event.message || stoppedMessage)
    for (const pending of pendingResults.values()) pending.reject(error)
    pendingResults.clear()
    queuedRequests.length = 0
    workerReady = false
    worker = undefined
  }

  function sendRequest(target: Worker, request: BunWorkerRequest<TJob>) {
    try {
      const prepared = prepareJob?.(request.job)
      if (!prepared) {
        target.postMessage(request)
        return
      }

      target.postMessage({ ...request, job: prepared.value }, prepared.transfer)
    } catch (error) {
      const pending = pendingResults.get(request.id)
      if (!pending) return

      pendingResults.delete(request.id)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
