# bun-worker

Call a module's exported functions in a Bun worker, the same way in Vite's dev server, Vite builds, Nitro's Bun preset, and bun-single-compile executables. It's private: apps install it locally.

```json
"dependencies": { "bun-worker": "file:../../libraries/bun-worker" }
```

Use `file:`, not `bun link`. A linked package resolves its own imports (`vite`, `nitro`) from outside the app. A `file:` install resolves peers from the app. It's a hard-linked copy, though, so after changing the library, run `bun update bun-worker` in each app (a plain `bun install` doesn't refresh it).

## Usage

Add the plugin. Importing it also brings in the types for `?bun-worker` imports.

```ts
// vite.config.ts
import { bunWorkerPlugin } from 'bun-worker/vite'
plugins: [bunWorkerPlugin() /* , tanstackStart(), ... */]
```

Write the worker as a plain module. Its exported functions are what callers can use.

```ts
// pdf.worker.ts
export async function renderReport(report: Report): Promise<Uint8Array> { … }
```

Import it with `?bun-worker` from server code and call the functions. Each call runs in the worker and returns a promise.

```ts
// report.server.ts
import pdfWorker from './pdf.worker.ts?bun-worker'

const pdf = pdfWorker<typeof import('./pdf.worker.ts')>()
const bytes = await pdf.renderReport(report)
```

The dev server runs the worker from source and restarts it after a source change, so no dev-only code path is needed.

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
