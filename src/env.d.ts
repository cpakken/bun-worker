// Reference from the app, e.g. `/// <reference types="bun-worker/env" />`.

interface ImportMetaEnv {
  /** True in `vite build` output, including NODE_ENV=development builds; false on the dev server. */
  readonly BUN_WORKER_BUILD: boolean
}

declare module '*?bun-worker' {
  const createWorker: (options?: WorkerOptions) => Worker
  export default createWorker
}
