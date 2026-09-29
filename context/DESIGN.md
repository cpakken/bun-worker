# Design

## Purpose

agri, canola, and dp-inventory each carried copies of the Bun worker plugin and runtime, and the copies drifted: canola missed the `BUN_WORKER_BUILD` hook and the error `name` field. This library holds the one maintained copy. It covers only running and reaching Bun workers; app-specific rendering (Takumi setup, fonts, templates) stays in the apps, and unrelated shared code belongs in its own library.

## Consumption

Apps install it with `file:`. With `bun link`, the package resolves its own imports from the global link directory, which can pull in a second copy of `vite` or `nitro`, or give their types as `any`. With `file:`, peers resolve inside each app's store. The catch is that `file:` installs are hard-linked copies, so new files and editors that save by replacing the file don't show up until the app runs `bun update bun-worker`; a plain `bun install` doesn't refresh them.

Bun also installs a `file:` package's devDependencies, as it does for a workspace member. A framework listed as a devDependency here therefore installs its own copy into each app, and TypeScript fails to compare the two copies' types (a Vite version mismatch gave "Excessive stack depth comparing types"). Keep frameworks as peers only; Bun installs peers automatically, so the library still gets Vite for its own tests. Nitro is the exception: it stays an optional peer (canola has no Nitro), so it is also a devDependency, pinned to the apps' version. Keep that pin matched to the apps.

## Environments

A `with { type: 'file' }` import resolves to a different path in each environment, and the worker plugin exists to handle this:

| Environment | Worker | File import |
| --- | --- | --- |
| Vite dev server | not emitted; render in process | Vite asset URL; resolve with `createRequire` |
| `vite build` (any mode) | built by `Bun.build` with packages external; listed in `bun-workers.json` | absolute path from node_modules |
| Nitro Bun preset | the Nitro hook rebundles manifest workers with packages bundled into `_ssr/` | relative to the module; `readFileAsset` resolves it |
| bun-single-compile | manifest workers staged as root-level entrypoints | absolute embedded path (`/$bunfs/…`, `B:/~BUN/…`) |

Nitro flattens SSR chunks into `_ssr/`, and the hook writes workers there. A worker URL therefore resolves only from a chunk, not from the SSR entry. TanStack Start server functions are always chunks, and the Nitro test mirrors this with a dynamic import.

`Bun.build` does not implement `with { type: 'bytes' }` (checked on 1.4.2): it returns the path string, so it can't replace `readFileAsset`.

## Tests

The integration tests write a small app under `node_modules/.cache` so builds resolve the library's own Vite and Nitro. Its worker uses a packaged file import and a `?raw` import, the same asset kinds the apps' PDF workers use. The tests check the output from a production build, a development build, a compiled executable, and a Nitro artifact run outside the repository.
