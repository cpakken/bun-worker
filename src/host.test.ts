import { expect, test } from 'bun:test'
import type { BunWorkerRequest, BunWorkerResponse } from './protocol'
import { serveBunWorker } from './host'

class FakeWorkerHost<TJob, TResult> {
  onmessage: ((event: MessageEvent<BunWorkerRequest<TJob>>) => void) | null = null
  readonly sent: BunWorkerResponse<TResult>[] = []
  onPost?: (response: BunWorkerResponse<TResult>) => void

  postMessage(response: BunWorkerResponse<TResult>) {
    this.sent.push(response)
    this.onPost?.(response)
  }

  send(request: BunWorkerRequest<TJob>) {
    this.onmessage?.(new MessageEvent('message', { data: request }))
  }
}

test('serves jobs sequentially and reports handler errors', async () => {
  const scope = new FakeWorkerHost<string, string>()
  let releaseFirst!: () => void
  const firstJobGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  let responseCount = 0
  scope.onPost = (response) => {
    if (response.status !== 'ready' && ++responseCount === 2) finish()
  }
  const started: string[] = []

  serveBunWorker<string, string>(scope as unknown as Worker, {
    async handle(job) {
      started.push(job)
      if (job === 'first') await firstJobGate
      if (job === 'second') throw new Error('Second job failed.')
      return job.toUpperCase()
    },
  })

  expect(scope.sent).toEqual([{ status: 'ready' }])
  scope.send({ id: 1, job: 'first' })
  scope.send({ id: 2, job: 'second' })
  await Promise.resolve()
  expect(started).toEqual(['first'])

  releaseFirst()
  await finished
  expect(started).toEqual(['first', 'second'])
  expect(scope.sent.slice(1)).toEqual([
    { id: 1, status: 'success', result: 'FIRST' },
    { id: 2, status: 'error', message: 'Second job failed.', name: 'Error' },
  ])
})
