import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hostFile = fileURLToPath(new URL('./host.ts', import.meta.url))

/** Source for the entry a worker starts from: it serves the module's exported functions. */
export function workerEntrySource(moduleFile: string) {
  return `import { serve } from ${JSON.stringify(hostFile)}
serve(() => import(${JSON.stringify(moduleFile)}))
`
}

/** Entry file name, unique per module so entries sharing a directory never overwrite each other. */
export function workerEntryFileName(name: string, moduleFile: string) {
  return `${name}-${Bun.hash(moduleFile).toString(36)}.worker.ts`
}

export function toWorkerName(moduleFile: string): string {
  const baseName = path
    .basename(moduleFile)
    .replace(/\.[^.]+$/, '')
    .replace(/\.worker$/, '')
  const name = baseName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  if (!name) throw new Error(`Could not derive a name for Bun worker: ${moduleFile}`)
  return name
}
