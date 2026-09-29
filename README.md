# bun-worker

Runs server code in Bun workers across Vite builds, Nitro's Bun preset, and bun-single-compile executables. It's private: apps install it locally.

```json
"dependencies": { "bun-worker": "file:../../libraries/bun-worker" }
```

Use `file:`, not `bun link`. A linked package resolves its own imports (`vite`, `nitro`) from outside the app. A `file:` install resolves peers from the app. It's a hard-linked copy, though, so after changing the library, run `bun update bun-worker` in each app (a plain `bun install` doesn't refresh it).

## Usage

```ts
// vite.config.ts
import { bunWorkerPlugin } from 'bun-worker/vite'
plugins: [bunWorkerPlugin() /* , tanstackStart(), ... */]
```

```ts
// src/bun-worker.d.ts
/// <reference types="bun-worker/env" />
```

```ts
// pdf.worker.ts
import { serveBunWorker } from 'bun-worker/host'
declare const self: Worker
serveBunWorker<Job, Uint8Array>(self, { handle: renderJob })

// worker-client.server.ts
import { createBunWorkerClient } from 'bun-worker/client'
import createPdfWorker from './pdf.worker.ts?bun-worker'
export const renderInWorker = createBunWorkerClient<Job, Uint8Array>({
  createWorker: () => createPdfWorker({ name: 'pdf' }),
  stoppedMessage: 'The PDF worker stopped unexpectedly.',
})
```

The Vite dev server doesn't emit workers, and calling the factory throws. Branch on `import.meta.env.BUN_WORKER_BUILD`: in dev, render in process; in any `vite build`, use the worker. `import.meta.env.DEV` doesn't work for this, because `build:dev` sets it too.

Other entries:
- `bun-worker/transfer`: `transferableBytes` moves results without a copy.
- `bun-worker/protocol`: the message types.
- `bun-worker/file-asset`: `readFileAsset(path, import.meta.url)` reads a `with { type: 'file' }` import (fonts, WASM) in built output, Nitro output, and compiled executables. The Vite dev server returns an asset URL for these imports, so in dev, resolve the package path with `createRequire(import.meta.url).resolve(...)` instead.
