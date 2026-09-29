import { expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWorkerApp, expectedEcho, runScript } from '@test/worker-app'

test('scripts run workers without Vite', async () => {
  const directory = await createWorkerApp('script-')
  try {
    const scriptFile = path.join(directory, 'script.ts')
    await writeFile(
      scriptFile,
      `import { runEcho } from './app.ts'
console.log(await runEcho('ping'))
`
    )
    const run = await runScript(scriptFile, { cwd: directory })
    expect(run.stderr).toBe('')
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe(expectedEcho)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

// Loader-based worker imports failed here: Bun 1.4.2's `--parallel` mode skips plugin loaders.
test('parallel bun test runs use workers without a preload', async () => {
  const directory = await createWorkerApp('parallel-test-')
  try {
    for (const name of ['first', 'second']) {
      await writeFile(
        path.join(directory, `${name}.test.ts`),
        `import { expect, test } from 'bun:test'
import { runEcho } from './app.ts'
test('${name}', async () => {
  expect(await runEcho('ping')).toBe(${JSON.stringify(expectedEcho)})
})
`
      )
    }
    const child = Bun.spawn([process.execPath, 'test', '--parallel=2'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect(output).toContain('2 pass')
    expect(exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
