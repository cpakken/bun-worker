import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerModule } from './types'
import { builtWorkerUrl, workerModule } from './client'
import { toWorkerName, workerEntryFileName, workerEntrySource } from './entry'

/** The Vite plugin replaces `worker()`'s URL argument in builds with a reference to the built file. */
export const builtWorkerKey = Symbol.for('bun-worker.built')

export type BuiltWorkerReference = {
  [builtWorkerKey]: { name: string; path: string; from: string }
}

const entryDirectory = path.join(tmpdir(), 'bun-worker')

/**
 * Calls a module's exported functions in a Bun worker. Pass the module as
 * `new URL('./module.ts', import.meta.url)`, written literally so builds can find it.
 */
export function worker<Module>(moduleUrl: URL): WorkerModule<Module> {
  const built = (moduleUrl as unknown as Partial<BuiltWorkerReference>)[builtWorkerKey]
  if (built) {
    return workerModule(built.name, built.name, () => new Worker(builtWorkerUrl(built.path, built.from), { name: built.name })) as WorkerModule<Module>
  }

  // Source modules (dev server, tests, scripts) start from a generated entry beside the others.
  const moduleFile = fileURLToPath(moduleUrl)
  const name = toWorkerName(moduleFile)
  return workerModule(moduleFile, name, () => {
    const entryFile = path.join(entryDirectory, workerEntryFileName(name, moduleFile))
    writeIfChanged(entryFile, workerEntrySource(moduleFile))
    return new Worker(entryFile, { name })
  }) as WorkerModule<Module>
}

function writeIfChanged(file: string, source: string) {
  let current: string | undefined
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = undefined
  }
  if (current === source) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source)
}
