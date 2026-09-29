export type WorkerCall = { id: number; method: string; args: unknown[] }

export type SerializedError = { name: string; message: string; stack?: string }

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError }
