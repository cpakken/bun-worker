import type { Nitro } from 'nitro/types'
import path from 'node:path'

/** Package the Vite workers that Nitro cannot discover through static imports. */
export async function bundleNitroBunWorkers(nitro: Nitro) {
  const ssrDirectory = path.join(nitro.options.buildDir, 'vite/services/ssr')
  const manifest = (await Bun.file(path.join(ssrDirectory, 'bun-workers.json')).json()) as {
    workers: Record<string, string>
  }
  const result = await Bun.build({
    entrypoints: Object.values(manifest.workers).map((file) => path.join(ssrDirectory, file)),
    // Nitro relocates the Vite SSR chunks here. Preserve each worker's filename
    // so the factory's URL remains valid beside its relocated calling module.
    outdir: path.join(nitro.options.output.serverDir, '_ssr'),
    naming: { entry: '[name].[ext]' },
    target: 'bun',
    packages: 'bundle',
    minify: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!result.success) {
    throw new Error(
      `Could not package Nitro Bun workers:\n${result.logs.map((log) => log.message).join('\n')}`
    )
  }
}
