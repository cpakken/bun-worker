import path from 'node:path'

/** Supports Vite's `?raw` text imports in Bun, for worker builds and dev workers. */
export function rawImportsPlugin(): Bun.BunPlugin {
  return {
    name: 'vite-raw-imports',
    setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: path.resolve(path.dirname(args.importer), args.path.slice(0, -'?raw'.length)),
        namespace: 'raw',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
        contents: `export default ${JSON.stringify(await Bun.file(args.path).text())}`,
        loader: 'js',
      }))
    },
  }
}
