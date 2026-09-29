import type { BunWorkerRequest, BunWorkerResponse, PreparedWorkerValue } from './protocol'

type BunWorkerHostOptions<TJob, TResult> = {
  handle: (job: TJob) => TResult | Promise<TResult>
  prepareResult?: (result: TResult) => PreparedWorkerValue<TResult> | undefined
}

/** Serves typed jobs sequentially inside a Bun worker. */
export function serveBunWorker<TJob, TResult>(
  scope: Worker,
  { handle, prepareResult }: BunWorkerHostOptions<TJob, TResult>
) {
  let handling = Promise.resolve()

  scope.onmessage = (event: MessageEvent<BunWorkerRequest<TJob>>) => {
    handling = handling.then(() => handleRequest(event.data))
  }

  scope.postMessage({ status: 'ready' } satisfies BunWorkerResponse<TResult>)

  async function handleRequest(request: BunWorkerRequest<TJob>) {
    try {
      const result = await handle(request.job)
      const prepared = prepareResult?.(result)
      const response = {
        id: request.id,
        status: 'success',
        result: prepared ? prepared.value : result,
      } satisfies BunWorkerResponse<TResult>

      scope.postMessage(response, prepared?.transfer ?? [])
    } catch (error) {
      const response = {
        id: request.id,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      } satisfies BunWorkerResponse<TResult>

      scope.postMessage(response)
    }
  }
}
