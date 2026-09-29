/** The functions a worker module exports, each called through the worker and returning a promise. */
export type WorkerModule<Module> = {
  readonly [Key in keyof Module as Module[Key] extends (...args: never[]) => unknown
    ? Key
    : never]: Module[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never
}
