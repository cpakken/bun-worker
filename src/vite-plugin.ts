import type { NitroModule } from 'nitro/types'
import type { Plugin } from 'vite'
import path from 'node:path'
import { bundleNitroBunWorkers } from './nitro.ts'

const workerQuery = '?bun-worker'
const resolvedWorkerPrefix = '\0bun-worker:'

type EmittedWorker = {
  name: string
  referenceId: string
}

/**
 * Turns `./worker.ts?bun-worker` imports into factories for isolated Bun workers.
 * Server builds also emit `bun-workers.json` so standalone compilers can
 * register the generated files as worker entrypoints.
 */
export function bunWorkerPlugin(): Plugin & { nitro: NitroModule } {
  const emittedWorkers = new Map<string, EmittedWorker>()
  const workerBuilds = new Map<string, Promise<EmittedWorker>>()
  const workerNameOwners = new Map<string, string>()

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
    config(_config, { command }) {
      // NODE_ENV=development builds still need emitted workers, not Vite's module runner.
      return { define: { 'import.meta.env.BUN_WORKER_BUILD': command === 'build' } }
    },
    configEnvironment(name) {
      if (name === 'ssr') return { build: { emitAssets: true } }
    },
    buildStart() {
      if (this.environment.name !== 'ssr' || this.environment.mode !== 'build') return
      emittedWorkers.clear()
      workerBuilds.clear()
      workerNameOwners.clear()
    },
    async resolveId(source, importer) {
      if (!source.endsWith(workerQuery)) return

      const workerSource = source.slice(0, -workerQuery.length)
      const resolved = await this.resolve(workerSource, importer, { skipSelf: true })
      if (!resolved) this.error(`Could not resolve Bun worker: ${workerSource}`)

      return `${resolvedWorkerPrefix}${resolved.id}`
    },
    async load(id) {
      if (!id.startsWith(resolvedWorkerPrefix)) return

      const workerEntry = id.slice(resolvedWorkerPrefix.length)
      if (this.environment.name !== 'ssr' || this.environment.mode === 'dev') {
        const message = `Bun worker ${workerEntry} is only emitted for server builds.`
        return `export default function createWorker() {
  throw new Error(${JSON.stringify(message)})
}`
      }

      let emittedWorker = emittedWorkers.get(workerEntry)
      if (!emittedWorker) {
        const workerName = toWorkerName(workerEntry)
        const existingOwner = workerNameOwners.get(workerName)
        if (existingOwner && existingOwner !== workerEntry) {
          this.error(
            `Bun worker name ${workerName} is shared by ${existingOwner} and ${workerEntry}.`
          )
        }
        workerNameOwners.set(workerName, workerEntry)

        let workerBuild = workerBuilds.get(workerEntry)
        if (!workerBuild) {
          workerBuild = (async () => {
            const workerSource = await buildWorker(workerEntry)
            return {
              name: workerName,
              referenceId: this.emitFile({
                type: 'asset',
                name: `${workerName}.worker.js`,
                source: workerSource,
              }),
            }
          })()
          workerBuilds.set(workerEntry, workerBuild)
        }

        emittedWorker = await workerBuild
        emittedWorkers.set(workerEntry, emittedWorker)
      }

      return `export default function createWorker(options) {
  const workerSpecifier = import.meta.ROLLUP_FILE_URL_${emittedWorker.referenceId}
  if (process.env.BUN_SINGLE_COMPILE_DEBUG === "1") {
    console.error("[bun-worker debug]", JSON.stringify({
      name: ${JSON.stringify(emittedWorker.name)},
      specifier: workerSpecifier,
      importMetaUrl: import.meta.url,
      importMetaDir: import.meta.dir,
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      cwd: process.cwd(),
    }, null, 2))
  }
  return new Worker(workerSpecifier, options)
}`
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

async function buildWorker(entry: string): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    packages: 'external',
    minify: true,
    plugins: [rawImportsPlugin()],
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

  const workerOutput = result.outputs.find((output) => output.kind === 'entry-point')
  if (!workerOutput) throw new Error(`Bun worker build did not produce an entrypoint: ${entry}`)

  return new Uint8Array(await workerOutput.arrayBuffer())
}

function toWorkerName(entry: string): string {
  const baseName = path
    .basename(entry)
    .replace(/\.[^.]+$/, '')
    .replace(/\.worker$/, '')
  const name = baseName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  if (!name) throw new Error(`Could not derive a name for Bun worker: ${entry}`)
  return name
}

function rawImportsPlugin(): Bun.BunPlugin {
  return {
    name: 'vite-raw-imports',
    setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
        namespace: 'raw',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
        contents: `export default ${JSON.stringify(await Bun.file(args.path).text())}`,
        loader: 'js',
      }))
    },
  }
}
