// Types for `?bun-worker` imports. The plugin and main entries reference this file, so apps get it
// by importing either one from a file their tsconfig includes.

declare module '*?bun-worker' {
  /** Returns the worker's exported functions: `worker<typeof import('./module.ts')>()`. */
  const worker: <Module>() => import('./types').WorkerModule<Module>
  export default worker
}
