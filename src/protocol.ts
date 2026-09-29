export type BunWorkerRequest<TJob> = {
  id: number
  job: TJob
}

export type BunWorkerResponse<TResult> =
  | { status: 'ready' }
  | { id: number; status: 'success'; result: TResult }
  | { id: number; status: 'error'; message: string; name: string }

export type PreparedWorkerValue<TValue> = {
  value: TValue
  transfer: Transferable[]
}
