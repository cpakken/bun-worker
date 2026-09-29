import { describe, expect, test } from 'bun:test'
import type { BunWorkerRequest, BunWorkerResponse } from './protocol'
import { createBunWorkerClient } from './client'

class FakeWorker<TJob, TResult> {
  onmessage: ((event: MessageEvent<BunWorkerResponse<TResult>>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly sent: Array<{ request: BunWorkerRequest<TJob>; transfer: Transferable[] }> = []

  postMessage(request: BunWorkerRequest<TJob>, transfer: Transferable[] = []) {
    this.sent.push({ request, transfer })
  }

  emit(response: BunWorkerResponse<TResult>) {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }

  fail(message = '') {
    this.onerror?.(new ErrorEvent('error', { message }))
  }
}

describe('Bun worker client', () => {
  test('queues jobs until ready and correlates out-of-order results', async () => {
    const worker = new FakeWorker<number, string>()
    const run = createBunWorkerClient<number, string>({
      createWorker: () => worker as unknown as Worker,
      stoppedMessage: 'Worker stopped.',
      prepareJob(job) {
        return { value: job * 2, transfer: [new ArrayBuffer(1)] }
      },
    })

    const first = run(2)
    const second = run(3)
    expect(worker.sent).toHaveLength(0)

    worker.emit({ status: 'ready' })
    expect(worker.sent.map(({ request }) => request)).toEqual([
      { id: 1, job: 4 },
      { id: 2, job: 6 },
    ])
    expect(worker.sent.every(({ transfer }) => transfer.length === 1)).toBeTrue()

    worker.emit({ id: 2, status: 'success', result: 'second' })
    worker.emit({ id: 1, status: 'success', result: 'first' })
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
  })

  test('rejects pending jobs and creates a fresh worker after failure', async () => {
    const workers = [new FakeWorker<string, string>(), new FakeWorker<string, string>()]
    let workerIndex = 0
    const run = createBunWorkerClient<string, string>({
      createWorker: () => workers[workerIndex++]! as unknown as Worker,
      stoppedMessage: 'Worker stopped.',
    })

    const failed = run('first')
    workers[0]!.emit({ status: 'ready' })
    workers[0]!.fail()
    await expect(failed).rejects.toThrow('Worker stopped.')

    const recovered = run('second')
    workers[1]!.emit({ status: 'ready' })
    workers[1]!.emit({ id: 2, status: 'success', result: 'recovered' })

    expect(workerIndex).toBe(2)
    expect(await recovered).toBe('recovered')
  })
})
