import { expect, test } from 'bun:test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWorkerApp, expectedEcho, librarySource } from '@test/worker-app'

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
    rolldownOptions: { output: { entryFileNames: 'assets/app.js' } },
  },
})`
      )
      const build = Bun.spawn([process.execPath, buildFile], {
        env: { ...process.env, NODE_ENV: nodeEnv },
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const [buildExit, buildErrors] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ])
      expect(buildErrors).toBe('')
      expect(buildExit).toBe(0)
      const manifest = JSON.parse(
        await readFile(path.join(outputDirectory, 'bun-workers.json'), 'utf8')
      ) as { version: number; workers: Record<string, string> }
      const workerFile = manifest.workers.echo!
      expect(manifest.version).toBe(1)
      expect(workerFile).toMatch(/^assets\/echo\.worker-[\w-]+\.js$/)

      const entryFile = path.join(directory, 'entry.ts')
      await writeFile(
        entryFile,
        `import { runEcho, workerBuild } from './dist/assets/app.js'
console.log(JSON.stringify({ workerBuild, echo: await runEcho('ping') }))
process.exit(0)
`
      )
      const expected = JSON.stringify({ workerBuild: true, echo: expectedEcho })
      const run = Bun.spawnSync([process.execPath, entryFile], {
        env: { ...process.env, NODE_ENV: nodeEnv },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
      expect(run.stderr.toString()).toBe('')
      expect(run.exitCode).toBe(0)
      expect(run.stdout.toString().trim()).toBe(expected)

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
      expect(compiledRun.stdout.toString().trim()).toBe(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000
)
