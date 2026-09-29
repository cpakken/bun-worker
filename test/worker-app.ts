import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const libraryRoot = path.resolve(import.meta.dir, '..')

/** JSON-quoted absolute path to a library source file, for generated fixture code. */
export const librarySource = (file: string) => JSON.stringify(path.join(libraryRoot, 'src', file))

export const expectedEcho = 'ping:packaged asset:raw note'

/**
 * Writes an app whose server module runs a job in a `?bun-worker` worker. The worker reads a
 * packaged file import and a `?raw` import, the two asset kinds the apps' PDF workers use.
 * It lives under node_modules so builds resolve the library's own Vite and Nitro.
 */
export async function createWorkerApp(prefix: string) {
  const cache = path.join(libraryRoot, 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(path.join(cache, prefix))
  const files = {
    'node_modules/fixture-asset/package.json': '{ "name": "fixture-asset" }\n',
    'node_modules/fixture-asset/asset.txt': 'packaged asset',
    'note.txt': 'raw note',
    'echo.worker.ts': `import { serveBunWorker } from ${librarySource('host.ts')}
import { readFileAsset } from ${librarySource('file-asset.ts')}
import assetPath from 'fixture-asset/asset.txt' with { type: 'file' }
import note from './note.txt?raw'

declare const self: Worker

serveBunWorker<string, string>(self, {
  async handle(job) {
    const asset = new TextDecoder().decode(await readFileAsset(assetPath, import.meta.url))
    return [job, asset, note].join(':')
  },
})
`,
    'app.ts': `import { createBunWorkerClient } from ${librarySource('client.ts')}
import createEchoWorker from './echo.worker.ts?bun-worker'

export const workerBuild = import.meta.env.BUN_WORKER_BUILD
export const runEcho = createBunWorkerClient<string, string>({
  createWorker: () => createEchoWorker({ name: 'echo' }),
  stoppedMessage: 'The echo worker stopped.',
})
`,
  }
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  return directory
}
