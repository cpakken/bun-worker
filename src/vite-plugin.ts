import type { NitroModule } from 'nitro/types'
import type { Plugin } from 'vite'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { restartWorkers } from './client.ts'
import { toWorkerName, workerEntryFileName, workerEntrySource } from './entry.ts'
import { bundleNitroBunWorkers } from './nitro.ts'

const libraryEntries = new Set(
  ['./index.ts', './worker.ts'].map((file) => fileURLToPath(new URL(file, import.meta.url)))
)

type EmittedWorker = {
  name: string
  referenceId: string
}

type Node = { type: string; start: number; end: number } & Record<string, unknown>

/**
 * Builds the workers that server code creates with `worker(new URL('./module.ts', import.meta.url))`.
 * Server builds bundle each module as an asset, point the call at it, and emit `bun-workers.json`
 * so standalone compilers can register the files as worker entrypoints. The dev server needs no
 * transform: it restarts workers after source changes.
 *
 * The return type names only the plugin, so an app checks it against its own Vite: the library's
 * Vite and Nitro types never meet the app's, even when their versions differ.
 */
export function bunWorkerPlugin(): { name: 'bun-worker' } {
  const emittedWorkers = new Map<string, EmittedWorker>()
  const workerBuilds = new Map<string, Promise<EmittedWorker>>()
  const workerNameOwners = new Map<string, string>()
  let entryDirectory = ''

  const plugin: Plugin & { nitro: NitroModule } & { name: 'bun-worker' } = {
    name: 'bun-worker',
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
    async transform(code, id) {
      if (this.environment.name !== 'ssr' || this.environment.mode !== 'build') return
      if (!code.includes('import.meta.url')) return

      const program = this.parse(code) as unknown as Node
      const workerNames = new Set<string>()
      for (const statement of program.body as Node[]) {
        if (statement.type !== 'ImportDeclaration') continue
        const source = (statement.source as { value: string }).value
        if (source !== 'bun-worker' && !libraryEntries.has((await this.resolve(source, id))?.id ?? '')) {
          continue
        }
        for (const specifier of statement.specifiers as Node[]) {
          const imported = specifier.imported as { name?: string; value?: string } | undefined
          if (specifier.type === 'ImportSpecifier' && (imported?.name ?? imported?.value) === 'worker') {
            workerNames.add((specifier.local as { name: string }).name)
          }
        }
      }
      if (workerNames.size === 0) return

      const calls: Node[] = []
      visit(program, (node) => {
        const callee = node.callee as Node | undefined
        if (node.type === 'CallExpression' && callee?.type === 'Identifier' && workerNames.has(callee.name as string)) {
          calls.push(node)
        }
      })

      let transformed = code
      for (const call of calls.toSorted((left, right) => right.start - left.start)) {
        const argument = (call.arguments as Node[])[0]
        const moduleSource = argument && moduleUrlSource(argument)
        if (!argument || moduleSource === undefined) {
          this.error(
            `worker() in ${id} must be called with new URL('./module.ts', import.meta.url) written directly, so the build can find the module.`
          )
        }
        const resolved = await this.resolve(moduleSource, id)
        if (!resolved) this.error(`Could not resolve Bun worker module ${moduleSource} from ${id}.`)

        const worker = await emitWorker(this, resolved.id)
        const reference = `{ [Symbol.for("bun-worker.built")]: { name: ${JSON.stringify(worker.name)}, path: import.meta.ROLLUP_FILE_URL_${worker.referenceId}, from: import.meta.url } }`
        transformed = transformed.slice(0, argument.start) + reference + transformed.slice(argument.end)
      }
      return { code: transformed, map: null }
    },
    resolveFileUrl: {
      // Ahead of Vite's asset handling, which would render a public /assets/ URL.
      order: 'pre',
      handler({ referenceId, relativePath }) {
        const isWorker = Array.from(emittedWorkers.values()).some(
          (worker) => worker.referenceId === referenceId
        )
        if (!isWorker) return

        return JSON.stringify(relativePath)
      },
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
  return plugin

  async function emitWorker(
    context: { emitFile: (file: { type: 'asset'; name: string; source: Uint8Array }) => string; error: (message: string) => never },
    moduleFile: string
  ) {
    const emitted = emittedWorkers.get(moduleFile)
    if (emitted) return emitted

    const name = toWorkerName(moduleFile)
    const existingOwner = workerNameOwners.get(name)
    if (existingOwner && existingOwner !== moduleFile) {
      context.error(`Bun worker name ${name} is shared by ${existingOwner} and ${moduleFile}.`)
    }
    workerNameOwners.set(name, moduleFile)

    let workerBuild = workerBuilds.get(moduleFile)
    if (!workerBuild) {
      workerBuild = (async () => {
        const entryFile = path.join(entryDirectory, workerEntryFileName(name, moduleFile))
        await mkdir(entryDirectory, { recursive: true })
        await Bun.write(entryFile, workerEntrySource(moduleFile))
        return {
          name,
          referenceId: context.emitFile({
            type: 'asset',
            name: `${name}.worker.js`,
            source: await buildWorker(entryFile),
          }),
        }
      })()
      workerBuilds.set(moduleFile, workerBuild)
    }
    const worker = await workerBuild
    emittedWorkers.set(moduleFile, worker)
    return worker
  }
}

/** The path in `new URL('<path>', import.meta.url)`, or undefined for any other expression. */
function moduleUrlSource(node: Node): string | undefined {
  const callee = node.callee as Node | undefined
  const [pathArgument, baseArgument] = (node.arguments ?? []) as Node[]
  const isImportMetaUrl =
    baseArgument?.type === 'MemberExpression' &&
    (baseArgument.object as Node).type === 'MetaProperty' &&
    (baseArgument.property as { name?: string }).name === 'url'
  if (node.type !== 'NewExpression' || callee?.type !== 'Identifier' || callee.name !== 'URL') {
    return undefined
  }
  if (pathArgument?.type !== 'Literal' || typeof pathArgument.value !== 'string' || !isImportMetaUrl) {
    return undefined
  }
  return pathArgument.value
}

function visit(node: unknown, callback: (node: Node) => void) {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback)
    return
  }
  if (typeof node !== 'object' || node === null || typeof (node as Node).type !== 'string') return
  callback(node as Node)
  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) visit(value, callback)
  }
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
