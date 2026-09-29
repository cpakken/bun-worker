import { expect, test } from 'bun:test'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkerApp, expectedEcho, librarySource } from '@test/worker-app'

test('Nitro artifact runs workers outside the repository without installed packages', async () => {
  const source = await createWorkerApp('nitro-build-')
  const deployment = await mkdtemp(path.join(tmpdir(), 'nitro-worker-deployment-'))
  let server: ReturnType<typeof Bun.spawn> | undefined
  try {
    // Load the worker client as a chunk, as TanStack Start server functions are. Nitro
    // flattens chunks into _ssr/, where the hook places the workers.
    await writeFile(
      path.join(source, 'nitro-server.ts'),
      `export default { async fetch() {
  const { runEcho } = await import('./app.ts')
  return new Response(await runEcho('ping'))
} }
`
    )
    const buildFile = path.join(source, 'build.ts')
    await writeFile(
      buildFile,
      `import { createBuilder } from 'vite'
import { nitro } from 'nitro/vite'
import { bunWorkerPlugin } from ${librarySource('vite-plugin.ts')}
const builder = await createBuilder({
  configFile: false,
  root: ${JSON.stringify(source)},
  logLevel: 'silent',
  environments: { ssr: { build: { rollupOptions: { input: ${JSON.stringify(path.join(source, 'nitro-server.ts'))} } } } },
  plugins: [bunWorkerPlugin(), nitro({
    preset: 'bun',
    logLevel: 0,
    buildDir: ${JSON.stringify(path.join(source, '.nitro'))},
    output: { dir: ${JSON.stringify(path.join(source, '.output'))} },
  })],
})
await builder.buildApp()
`
    )
    const build = Bun.spawn([process.execPath, buildFile], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const [buildExit, buildErrors] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ])
    if (buildExit !== 0) throw new Error(buildErrors)
    await cp(path.join(source, '.output'), path.join(deployment, '.output'), { recursive: true })
    await rm(source, { recursive: true, force: true })

    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = reservation.port
    await reservation.stop(true)
    const runningServer = Bun.spawn([process.execPath, '.output/server/index.mjs'], {
      cwd: deployment,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(port),
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    server = runningServer
    const serverErrors = new Response(runningServer.stderr).text()
    let response: Response | undefined
    const deadline = Date.now() + 10_000
    while (!response && Date.now() < deadline) {
      response = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined)
      if (!response) await Bun.sleep(50)
    }
    if (!response) {
      runningServer.kill('SIGKILL')
      throw new Error(`Nitro did not respond:\n${await serverErrors}`)
    }
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(expectedEcho)
  } finally {
    // The disposable server owns a persistent worker; stop both after verification.
    server?.kill('SIGKILL')
    if (server) await server.exited
    await Promise.all(
      [source, deployment].map((directory) => rm(directory, { recursive: true, force: true }))
    )
  }
}, 30_000)
