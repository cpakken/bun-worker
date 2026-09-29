import { expect, test } from 'bun:test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWorkerApp, expectedEcho, librarySource, runScript, viteModule } from '@test/worker-app'

test.each(['production', 'development'])(
  'runs workers from a %s build and a standalone executable',
  async (nodeEnv) => {
    const directory = await createWorkerApp('vite-build-')
    const outputDirectory = path.join(directory, 'dist')
    try {
      // Isolate NODE_ENV: Vite derives DEV from it even when the command is build.
      const buildFile = path.join(directory, 'build.ts')
      await writeFile(
        buildFile,
        `import { build } from 'vite'
import { bunWorkerPlugin } from ${librarySource('vite-plugin.ts')}
await build({
  configFile: false,
  root: ${JSON.stringify(directory)},
  mode: ${JSON.stringify(nodeEnv)},
  logLevel: 'silent',
  plugins: [bunWorkerPlugin()],
  build: {
    ssr: 'app.ts', outDir: ${JSON.stringify(outputDirectory)}, emptyOutDir: true, copyPublicDir: false,
    rolldownOptions: { output: { entryFileNames: 'app.js' } },
  },
})`
      )
      const build = await runScript(buildFile, { env: { NODE_ENV: nodeEnv } })
      expect(build.stderr).toBe('')
      expect(build.exitCode).toBe(0)
      const manifest = JSON.parse(
        await readFile(path.join(outputDirectory, 'bun-workers.json'), 'utf8')
      ) as { version: number; workers: Record<string, string> }
      const workerFile = manifest.workers.echo!
      expect(manifest.version).toBe(1)
      expect(workerFile).toMatch(/^assets\/echo\.worker-[\w-]+\.js$/)

      // No process.exit: an idle worker must not keep the process alive.
      const entryFile = path.join(directory, 'entry.ts')
      await writeFile(
        entryFile,
        `import { runEcho } from './dist/app.js'
console.log(await runEcho('ping'))
`
      )
      const run = await runScript(entryFile, { env: { NODE_ENV: nodeEnv } })
      expect(run.stderr).toBe('')
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toBe(expectedEcho)

      // Match bun-single-compile's root-level worker staging, then remove emitted files.
      const stagedWorker = path.join(directory, path.basename(workerFile))
      await copyFile(path.join(outputDirectory, workerFile), stagedWorker)
      const deployment = path.join(directory, 'deployment')
      await mkdir(deployment)
      const executable = path.join(deployment, process.platform === 'win32' ? 'echo.exe' : 'echo')
      const compiled = await Bun.build({
        entrypoints: [entryFile, stagedWorker],
        compile: { outfile: executable },
      })
      expect(compiled.success).toBeTrue()
      if (process.platform === 'darwin') {
        expect(Bun.spawnSync(['codesign', '--force', '--sign', '-', executable]).exitCode).toBe(0)
      }
      await rm(outputDirectory, { recursive: true })
      await Promise.all([entryFile, stagedWorker].map((file) => rm(file)))
      const compiledRun = Bun.spawnSync([executable], {
        cwd: deployment,
        env: { ...process.env, NODE_ENV: nodeEnv },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
      expect(compiledRun.stderr.toString()).toBe('')
      expect(compiledRun.exitCode).toBe(0)
      expect(compiledRun.stdout.toString().trim()).toBe(expectedEcho)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000
)

test('the dev server runs workers from source and restarts them after changes', async () => {
  const directory = await createWorkerApp('vite-dev-', { watched: true })
  try {
    const devFile = path.join(directory, 'dev.ts')
    await writeFile(
      devFile,
      `import { createServer } from ${viteModule}
import { writeFile } from 'node:fs/promises'
import { bunWorkerPlugin } from ${librarySource('vite-plugin.ts')}
const server = await createServer({
  configFile: false,
  root: ${JSON.stringify(directory)},
  logLevel: 'silent',
  server: { middlewareMode: true, ws: false },
  plugins: [bunWorkerPlugin()],
})
const app = await server.ssrLoadModule('/app.ts')
console.log(await app.runEcho('ping'))
await writeFile(${JSON.stringify(path.join(directory, 'note.txt'))}, 'edited note')
const deadline = Date.now() + 5_000
let edited = ''
while (Date.now() < deadline) {
  edited = await app.runEcho('ping')
  if (edited.endsWith('edited note')) break
  await Bun.sleep(50)
}
console.log(edited)
await server.close()
`
    )
    const dev = await runScript(devFile)
    expect(dev.stderr).toBe('')
    expect(dev.exitCode).toBe(0)
    expect(dev.stdout.split('\n')).toEqual([expectedEcho, 'ping:packaged asset:edited note'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('builds reject worker() calls without a literal module URL', async () => {
  const directory = await createWorkerApp('vite-dynamic-url-')
  try {
    await writeFile(
      path.join(directory, 'app.ts'),
      `import { worker } from ${librarySource('index.ts')}
const moduleUrl = new URL('./echo.worker.ts', import.meta.url)
export const echoWorker = worker(moduleUrl)
`
    )
    const buildFile = path.join(directory, 'build.ts')
    await writeFile(
      buildFile,
      `import { build } from 'vite'
import { bunWorkerPlugin } from ${librarySource('vite-plugin.ts')}
await build({
  configFile: false,
  root: ${JSON.stringify(directory)},
  logLevel: 'silent',
  plugins: [bunWorkerPlugin()],
  build: { ssr: 'app.ts', outDir: ${JSON.stringify(path.join(directory, 'dist'))} },
})`
    )
    const build = await runScript(buildFile)
    expect(build.exitCode).not.toBe(0)
    expect(build.stderr).toContain("must be called with new URL('./module.ts', import.meta.url)")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
