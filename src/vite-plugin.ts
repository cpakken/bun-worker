// Ambient types for `?bun-worker` imports can only ship through a reference.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./env.d.ts" />
import type { NitroModule } from 'nitro/types'
import type { Plugin } from 'vite'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { restartWorkers } from './client.ts'
import { bundleNitroBunWorkers } from './nitro.ts'

const workerQuery = '?bun-worker'
const resolvedWorkerPrefix = '\0bun-worker:'
const libraryFile = (file: string) => fileURLToPath(new URL(file, import.meta.url))
const clientFile = libraryFile('./client.ts')
const hostFile = libraryFile('./host.ts')

type EmittedWorker = {
  name: string
  referenceId: string
}

/**
 * Runs `./module.ts?bun-worker` imports in a Bun worker: the dev server starts one from source,
 * and server builds bundle it as an asset. Builds also emit `bun-workers.json` so standalone
 * compilers can register the generated files as worker entrypoints.
 */
export function bunWorkerPlugin(): Plugin & { nitro: NitroModule } {
  const emittedWorkers = new Map<string, EmittedWorker>()
  const workerBuilds = new Map<string, Promise<EmittedWorker>>()
  const workerNameOwners = new Map<string, string>()
  let entryDirectory = ''

  async function writeWorkerEntry(name: string, moduleFile: string) {
    // Unique per module: builds that share a Vite cache directory must not overwrite each other.
    const entryFile = path.join(entryDirectory, `${name}-${Bun.hash(moduleFile).toString(36)}.worker.ts`)
    const source = `import { serve } from ${JSON.stringify(hostFile)}
serve(() => import(${JSON.stringify(moduleFile)}))
`
    const current = await Bun.file(entryFile)
      .text()
      .catch(() => undefined)
    if (current !== source) {
      await mkdir(entryDirectory, { recursive: true })
      await Bun.write(entryFile, source)
    }
    return entryFile
  }

  return {
    name: 'bun-worker',
    enforce: 'pre',
    nitro: {
      setup(nitro) {
        if (nitro.options.preset !== 'bun') return
        nitro.hooks.hook('compiled', async () => {
          if (emittedWorkers.size) await bundleNitroBunWorkers(nitro)
        })
      },
    },
    configResolved(config) {
      entryDirectory = path.join(config.cacheDir, 'bun-worker')
    },
    configEnvironment(name) {
      if (name === 'ssr') return { build: { emitAssets: true } }
    },
    configureServer(server) {
      // Worker code runs outside Vite's module graph, so any source change restarts the workers.
      server.watcher.on('all', (_event, file) => {
        if (!file.includes(`${path.sep}node_modules${path.sep}`)) restartWorkers()
      })
    },
    buildStart() {
      if (this.environment.name !== 'ssr' || this.environment.mode !== 'build') return
      emittedWorkers.clear()
      workerBuilds.clear()
      workerNameOwners.clear()
    },
    async resolveId(source, importer) {
      if (!source.endsWith(workerQuery)) return

      const moduleSource = source.slice(0, -workerQuery.length)
      const resolved = await this.resolve(moduleSource, importer, { skipSelf: true })
      if (!resolved) this.error(`Could not resolve Bun worker module: ${moduleSource}`)

      return `${resolvedWorkerPrefix}${resolved.id}`
    },
    async load(id) {
      if (!id.startsWith(resolvedWorkerPrefix)) return

      const moduleFile = id.slice(resolvedWorkerPrefix.length)
      if (this.environment.name !== 'ssr') {
        const message = `Bun worker ${moduleFile} can only run in server code.`
        return `export default function worker() {
  throw new Error(${JSON.stringify(message)})
}`
      }

      const name = toWorkerName(moduleFile)
      const existingOwner = workerNameOwners.get(name)
      if (existingOwner && existingOwner !== moduleFile) {
        this.error(`Bun worker name ${name} is shared by ${existingOwner} and ${moduleFile}.`)
      }
      workerNameOwners.set(name, moduleFile)
      const entryFile = await writeWorkerEntry(name, moduleFile)

      if (this.environment.mode === 'dev') {
        return clientModule(
          name,
          `new Worker(${JSON.stringify(entryFile)}, { name: ${JSON.stringify(name)} })`
        )
      }

      let emittedWorker = emittedWorkers.get(moduleFile)
      if (!emittedWorker) {
        let workerBuild = workerBuilds.get(moduleFile)
        if (!workerBuild) {
          workerBuild = (async () => ({
            name,
            referenceId: this.emitFile({
              type: 'asset',
              name: `${name}.worker.js`,
              source: await buildWorker(entryFile),
            }),
          }))()
          workerBuilds.set(moduleFile, workerBuild)
        }
        emittedWorker = await workerBuild
        emittedWorkers.set(moduleFile, emittedWorker)
      }

      return clientModule(
        name,
        `new Worker(import.meta.ROLLUP_FILE_URL_${emittedWorker.referenceId}, { name: ${JSON.stringify(name)} })`
      )
    },
    resolveFileUrl({ referenceId, relativePath }) {
      const isWorker = Array.from(emittedWorkers.values()).some(
        (worker) => worker.referenceId === referenceId
      )
      if (!isWorker) return

      return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`
    },
    generateBundle() {
      if (this.environment.name !== 'ssr' || this.environment.mode !== 'build') return
      if (emittedWorkers.size === 0) return

      const workers = Object.fromEntries(
        Array.from(emittedWorkers.values())
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((worker) => [worker.name, this.getFileName(worker.referenceId)])
      )

      this.emitFile({
        type: 'asset',
        fileName: 'bun-workers.json',
        source: `${JSON.stringify({ version: 1, workers }, null, 2)}\n`,
      })
    },
  }
}

function clientModule(name: string, createWorker: string) {
  return `import { workerModule } from ${JSON.stringify(clientFile)}
export default workerModule(${JSON.stringify(name)}, () => ${createWorker})
`
}

async function buildWorker(entry: string): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    packages: 'external',
    minify: true,
    define: {
      'import.meta.env.DEV': 'false',
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  })
  if (!result.success) {
    throw new Error(
      `Could not build Bun worker ${entry}:\n${result.logs.map((log) => log.message).join('\n')}`
    )
  }

  const outputs = result.outputs.filter((output) => output.kind !== 'sourcemap')
  const workerOutput = outputs.find((output) => output.kind === 'entry-point')
  if (!workerOutput || outputs.length !== 1) {
    throw new Error(
      `Bun worker build must produce a single file: ${entry} produced ${outputs.map((output) => output.path).join(', ')}`
    )
  }

  return new Uint8Array(await workerOutput.arrayBuffer())
}

function toWorkerName(moduleFile: string): string {
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
