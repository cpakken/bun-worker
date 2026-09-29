# bun-worker

Call a module's exported functions in a Bun worker, the same way on Vite's dev server, in Vite builds, Nitro's Bun preset, bun-single-compile executables, `bun test`, and plain scripts. It's private: apps install it locally.

```json
"dependencies": { "bun-worker": "file:../../libraries/bun-worker" }
```

Use `file:`, not `bun link`. A linked package resolves its own imports (`vite`, `nitro`) from outside the app. A `file:` install resolves peers from the app. It's a hard-linked copy, though: after changing the library, run `bun update bun-worker` in each app. That refreshes changed and added files but leaves deleted ones behind, so after the library deletes or renames a file, remove the app's `node_modules/.bun/bun-worker@file*` directory and run `bun install`.

## Usage

Write the worker as a plain module. Its exported functions are what callers can use.

```ts
// pdf.worker.ts
export async function renderReport(report: Report): Promise<Uint8Array> { … }
```

Create the worker from server code and call its functions. Each call runs in the worker and returns a promise.

```ts
// report.server.ts
import { worker } from 'bun-worker'

const pdf = worker<typeof import('./pdf.worker.ts')>(new URL('./pdf.worker.ts', import.meta.url))
const bytes = await pdf.renderReport(report)
```

Write the `new URL('./…', import.meta.url)` argument literally: builds find worker modules by that pattern and fail with an error for anything else.

Add the plugin so builds bundle the workers and the dev server restarts them after source changes:

```ts
// vite.config.ts
import { bunWorkerPlugin } from 'bun-worker/vite'
plugins: [bunWorkerPlugin() /* , tanstackStart(), ... */]
```

`bun test` and scripts need nothing extra: the worker starts from source, as on the dev server.

Arguments and results are copied between threads, so they must be structured-cloneable (no functions or class instances). Returned bytes (`ArrayBuffer`, typed arrays) move to the caller without a copy. To move a large argument instead of copying it, mark it; the caller's copy becomes unusable:

```ts
import { transfer } from 'bun-worker'
await parser.parse(transfer(bytes, [bytes.buffer]))
```

## Worker code is Bun code

The calling code goes through Vite; the worker module and everything it imports run as plain Bun in every environment, including the dev server. Use Bun's native equivalents of Vite features:

| Need | Vite | In a worker |
| --- | --- | --- |
| Path aliases | `resolve.alias` | tsconfig `paths` |
| Environment variables | `import.meta.env` | `process.env` or `Bun.env` |
| File contents as a string | `?raw` | `import text from './file.svg' with { type: 'text' }` |
| File path (fonts, WASM) | `?url` | `import path from 'pkg/file.wasm' with { type: 'file' }`, read with `readFileAsset` |

Other plugins' transforms and `import.meta.glob` aren't available. TypeScript types an import by its path, not its `with` attribute, so a text import of a file type TypeScript doesn't know needs a declaration such as `declare module '*.svg' { const content: string; export default content }`. Projects that include `vite/client` types already have one for `.svg`.

## File assets

`readFileAsset(path, import.meta.url)` from `bun-worker` reads a `with { type: 'file' }` import (fonts, WASM) wherever the worker runs. Nitro output gives these imports paths relative to the module; everywhere else they're absolute.

## Deployment

- **Nitro (Bun preset):** the plugin's Nitro hook packages the workers into the server output. Nothing to configure.
- **bun-single-compile:** point `application.workers` at the manifest, or the executable starts but every worker call fails:

  ```ts
  application: { kind: 'fetch', entry: 'dist/server/server.js', workers: 'dist/server/bun-workers.json' }
  ```
