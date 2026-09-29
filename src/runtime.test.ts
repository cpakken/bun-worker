import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { createFixtureDirectory, librarySource, writeFiles } from '@test/worker-app'
import { restartWorkers, workerModule } from './client'
import { transfer } from './transfer'

type Fixture = {
  add: (left: number, right: number) => Promise<number>
  count: () => Promise<number>
  fail: () => Promise<never>
  crash: () => Promise<never>
  bytes: (size: number) => Promise<Uint8Array>
  retainedLength: () => Promise<number>
  slice: () => Promise<Uint8Array>
  receive: (bytes: Uint8Array) => Promise<number>
}

// Bun 1.4.2's `expect(promise).rejects` never settles when a worker message settles the promise.
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message
  )

let directory: string
let fixture: Fixture

beforeAll(async () => {
  directory = await createFixtureDirectory('runtime-')
  await writeFiles(directory, {
    'fixture.ts': `let calls = 0
let retained: Uint8Array | undefined

export async function add(left: number, right: number) {
  await Bun.sleep(right)
  return left + right
}
export function count() {
  return ++calls
}
export function fail() {
  throw new RangeError('Out of range.')
}
export function crash() {
  process.exit(1)
}
export function bytes(size: number) {
  retained = new Uint8Array(size).fill(7)
  return retained
}
export function retainedLength() {
  return retained?.byteLength ?? -1
}
export function slice() {
  retained = new Uint8Array(8).fill(3)
  return retained.subarray(2, 4)
}
export function receive(bytes: Uint8Array) {
  return bytes.byteLength
}
`,
    'entry.ts': `import { serve } from ${librarySource('host.ts')}
serve(() => import('./fixture.ts'))
`,
    'broken.ts': `throw new TypeError('Module failed to load.')`,
    'broken-entry.ts': `import { serve } from ${librarySource('host.ts')}
serve(() => import('./broken.ts'))
`,
  })
  const entry = path.join(directory, 'entry.ts')
  fixture = workerModule('fixture', () => new Worker(entry))() as Fixture
})

afterAll(async () => {
  restartWorkers()
  await rm(directory, { recursive: true, force: true })
})

describe('worker modules', () => {
  test('call exported functions and match concurrent results to their calls', async () => {
    expect(await Promise.all([fixture.add(1, 30), fixture.add(2, 0)])).toEqual([31, 2])
  })

  test('reject with the error name and message thrown in the worker', async () => {
    const error = await fixture.fail().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('RangeError')
    expect((error as Error).message).toBe('Out of range.')
    const missing = (fixture as unknown as Record<string, () => Promise<unknown>>).missing!()
    expect(await rejection(missing)).toContain('no exported function "missing"')
  })

  test('move returned bytes and copy views that share a larger buffer', async () => {
    expect(Array.from(await fixture.bytes(4))).toEqual([7, 7, 7, 7])
    expect(await fixture.retainedLength()).toBe(0)
    expect(Array.from(await fixture.slice())).toEqual([3, 3])
    expect(await fixture.retainedLength()).toBe(8)
  })

  test('move marked arguments and copy the rest', async () => {
    const copied = new Uint8Array(4)
    expect(await fixture.receive(copied)).toBe(4)
    expect(copied.byteLength).toBe(4)

    const moved = new Uint8Array(4)
    expect(await fixture.receive(transfer(moved, [moved.buffer]))).toBe(4)
    expect(moved.byteLength).toBe(0)
  })

  test('replace a worker that exits and restart one on request', async () => {
    const first = await fixture.count()
    expect(await rejection(fixture.crash())).toContain('exited unexpectedly')
    expect(await fixture.count()).toBe(1)
    expect(first).toBeGreaterThan(0)

    await fixture.count()
    restartWorkers()
    expect(await fixture.count()).toBe(1)
  })

  test('reject each call when the module fails to load', async () => {
    const entry = path.join(directory, 'broken-entry.ts')
    const broken = workerModule('broken', () => new Worker(entry))() as Fixture
    expect(await rejection(broken.count())).toBe('Module failed to load.')
    expect(await rejection(broken.count())).toBe('Module failed to load.')
  })
})
