# Design

## Purpose

agri, canola, and dp-inventory each carried copies of the Bun worker plugin and runtime, and the copies drifted: canola missed the `BUN_WORKER_BUILD` hook and the error `name` field. This library holds the one maintained copy. It covers only running and reaching Bun workers; app-specific rendering (Takumi setup, fonts, templates) stays in the apps, and unrelated shared code belongs in its own library.

## Model

An app wants to call a function on another thread. A worker is therefore a plain module whose exported functions callers use through a typed proxy (`pdfWorker<typeof import('./pdf.worker.ts')>()`). The plugin generates both sides: a worker entry (`serve(() => import(module))`) and the caller's module (`workerModule(name, () => new Worker(...))`). Apps never write message handling, protocol types, or dispatch code.

The earlier design exposed that plumbing (client, host, protocol, transfer, and env entries) and ran worker code in process on the dev server. Each app then needed a dispatcher that branched on `BUN_WORKER_BUILD`, a dev-only font path, and Vite externals for the assets the in-process path pulled into the SSR bundle. That branching is where the copies drifted. Worker code has to run as plain Bun anyway, because builds bundle it with `Bun.build` rather than Vite, so the dev server now runs it in a real worker too, and each of those pieces disappears.

Worker code is therefore pure Bun, with no exceptions: the calling code goes through Vite, and the worker graph uses Bun's native equivalents (tsconfig paths, `process.env`, `with { type: 'text' }`, `with { type: 'file' }`). The library once supported `?raw` in workers through a Bun plugin loaded in builds and preloaded into dev workers; it was the only Vite feature any worker used, and Bun's text import replaces it, so the plugin and the preload are gone.

Vite 8 does not pass import attributes to plugin hooks (checked: `resolveId` receives none in builds and `{}` in dev). So `import * as pdf from './pdf.worker.ts' with { type: 'bun-worker' }`, which would type the proxy for free, can't work. The `?bun-worker` query stays, and the caller names the module type once.

## Behavior

- One worker per module, started on first call and handling one call at a time. It holds the process open only while calls are pending.
- The worker attaches its listener before loading the module, so calls made during initialization (such as WASM setup) wait rather than being lost. If the module fails to load, every call rejects with that error.
- Errors keep their name, message, and worker stack. A crashed or exited worker rejects its pending calls, and the next call starts a fresh one.
- Returned `ArrayBuffer`s and whole-buffer typed arrays are transferred. A view into a larger buffer is copied first, because transferring would detach data the worker still holds (a WASM memory view, for example). Arguments are copied unless marked with `transfer()`, because transferring detaches the caller's copy.
- The call registry and transfer marks live on `globalThis`: the Vite dev server loads the generated module and the library as more than one module instance, and each must find the same state.
- On the dev server, any source change outside `node_modules` restarts the workers once their pending calls finish, since worker code sits outside Vite's module graph. The first call after a change pays for a fresh worker (about 175 ms for agri's PDF worker, against 28 ms warm).
- Generated worker entries live in Vite's cache directory, named with a hash of the module path, because builds that share a cache directory would otherwise overwrite each other's entries.

## Consumption

Apps install it with `file:`. With `bun link`, the package resolves its own imports from the global link directory, which can pull in a second copy of `vite` or `nitro`, or give their types as `any`. With `file:`, peers resolve inside each app's store. The catch is that `file:` installs are hard-linked copies, so new files and editors that save by replacing the file don't show up until the app runs `bun update bun-worker`; a plain `bun install` doesn't refresh them.

Bun also installs a `file:` package's devDependencies, as it does for a workspace member. A framework listed as a devDependency here therefore installs its own copy into each app, and TypeScript fails to compare the two copies' types (a Vite version mismatch gave "Excessive stack depth comparing types"). Keep frameworks as peers only; Bun installs peers automatically, so the library still gets Vite for its own tests. Nitro is the exception: it stays an optional peer (canola has no Nitro), so it is also a devDependency, pinned to the apps' version. Keep that pin matched to the apps.

The `?bun-worker` types ship through a triple-slash reference in the plugin and main entries, since a wildcard module declaration can't live in a module file. Apps get them by importing the plugin from a file their tsconfig includes, which the Vite config normally is.

## Environments

A `with { type: 'file' }` import resolves to a different path in each environment:

| Environment | Worker | File import |
| --- | --- | --- |
| Vite dev server | runs the source directly | absolute path from node_modules |
| `vite build` (any mode) | built by `Bun.build` with packages external; listed in `bun-workers.json` | absolute path from node_modules |
| Nitro Bun preset | the Nitro hook rebundles manifest workers with packages bundled into `_ssr/` | relative to the module; `readFileAsset` resolves it |
| bun-single-compile | manifest workers staged as root-level entrypoints | absolute embedded path (`/$bunfs/…`, `B:/~BUN/…`) |

A worker build must produce a single file. A local file import inside a worker would emit a second asset that the plugin can't place, so the build fails instead of silently dropping it. Packaged assets are fine, because they stay external until Nitro or compile bundles them.

Nitro flattens SSR chunks into `_ssr/`, and the hook writes workers there. A worker URL therefore resolves only from a chunk, not from the SSR entry. TanStack Start server functions are always chunks, and the Nitro test mirrors this with a dynamic import.

`Bun.build` does not implement `with { type: 'bytes' }` (checked on 1.4.2): it returns the path string, so it can't replace `readFileAsset`.

## Considered alternatives

**Vite's own workers** (`?worker` and `new Worker(new URL(...))`) are browser workers, not server workers. The dev server serves them over HTTP, which Bun can't load as a worker. Builds bundle them through Vite's browser-targeted `worker` pipeline: server builds emit no worker file and point at a public `/assets/...` URL by default, top-level await needs `worker.format: 'es'`, and `node:` builtins become empty browser stubs. The `new URL(...)` form isn't processed in server builds at all.

**A Vite Environment API version** would run worker code through Vite, as a server counterpart of Vite's worker pipeline. A Vite module runner inside a Bun worker, connected to a custom environment over a `MessagePort`, works on Vite 8: a Vite alias and `import.meta.env` resolved in the worker. It was not adopted, for three reasons:
- Vite ignores Bun's `with { type: 'file' }`, and Rolldown drops import attributes from external imports with no option to keep them. File imports would need text-patching of the output, or assets inlined with `?inline`.
- Workers would have to be built by Vite before TanStack Start's server build and Nitro's compile hook.
- Parts of the API are experimental.

Bun natively covers what server code usually wants from Vite, so the benefit, Vite features inside workers, didn't justify those costs. Revisit if workers need other plugins' transforms. In that case, find workers by convention (`*.worker.ts`) so they can be built first, and consider bundling every dependency into each worker so Nitro and compile only copy the file.

## Tests

The integration tests write a small app with a worker that uses a packaged file import and a text import, the same asset kinds the apps' PDF workers use. The tests check a production build, a development build, a compiled executable, a Nitro artifact run outside the repository, and the dev server, including a restart after a source change. Build fixtures live under `node_modules/.cache` so they resolve the library's own Vite and Nitro. Vite's watcher ignores `node_modules`, so the dev test uses the system temp directory and imports Vite by absolute path.

The runtime tests run real workers. Bun 1.4.2's `expect(promise).rejects` never settles when a worker message settles the promise, so they check rejections through `.then`.
