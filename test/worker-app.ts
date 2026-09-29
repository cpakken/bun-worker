import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const libraryRoot = path.resolve(import.meta.dir, '..')

/** JSON-quoted absolute path to a library source file, for generated fixture code. */
export const librarySource = (file: string) => JSON.stringify(path.join(libraryRoot, 'src', file))

/** JSON-quoted absolute path to the library's Vite, for scripts run outside the library. */
export const viteModule = JSON.stringify(Bun.resolveSync('vite', libraryRoot))

export const expectedEcho = 'ping:packaged asset:text note'

/**
 * Creates a temporary directory under node_modules so fixtures resolve the library's own Vite and
 * Nitro. Vite's watcher ignores node_modules, so tests that watch files use the system temp directory.
 */
export async function createFixtureDirectory(prefix: string, options: { watched?: boolean } = {}) {
  if (options.watched) return mkdtemp(path.join(tmpdir(), `bun-worker-${prefix}`))
  const cache = path.join(libraryRoot, 'node_modules/.cache')
  await mkdir(cache, { recursive: true })
  return mkdtemp(path.join(cache, prefix))
}

export async function writeFiles(directory: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
}

/**
 * Writes an app whose `app.ts` calls a `?bun-worker` module. The worker reads a packaged file
 * import and a text import, the two asset kinds the apps' PDF workers use.
 */
export async function createWorkerApp(prefix: string, options: { watched?: boolean } = {}) {
  const directory = await createFixtureDirectory(prefix, options)
  await writeFiles(directory, {
    'node_modules/fixture-asset/package.json': '{ "name": "fixture-asset" }\n',
    'node_modules/fixture-asset/asset.txt': 'packaged asset',
    'note.txt': 'text note',
    'echo.worker.ts': `import { readFileAsset } from ${librarySource('index.ts')}
import assetPath from 'fixture-asset/asset.txt' with { type: 'file' }
import note from './note.txt' with { type: 'text' }

export async function echo(job: string) {
  const asset = new TextDecoder().decode(await readFileAsset(assetPath, import.meta.url))
  return [job, asset, note].join(':')
}
`,
    'app.ts': `import echoWorker from './echo.worker.ts?bun-worker'

const worker = echoWorker<typeof import('./echo.worker.ts')>()
export const runEcho = (job: string) => worker.echo(job)
`,
  })
  return directory
}

/** Runs a script in a separate Bun process and returns its trimmed output. */
export async function runScript(file: string, options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, file], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}
