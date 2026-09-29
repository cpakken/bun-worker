// Shared through globalThis: Vite can load this file as more than one module instance.
const markedKey: unique symbol = Symbol.for('bun-worker.transfer')
const processState = globalThis as { [markedKey]?: WeakMap<object, Transferable[]> }
const marked = (processState[markedKey] ??= new WeakMap())

/**
 * Moves `transferables` instead of copying them when `value` crosses the worker boundary. Use it
 * for large arguments; the caller's copies become unusable. Returned bytes move automatically.
 */
export function transfer<Value extends object>(value: Value, transferables: Transferable[]) {
  marked.set(value, transferables)
  return value
}

/** Transferables marked on top-level call arguments. */
export function argumentTransfers(args: unknown[]) {
  return args.flatMap((arg) => (isObject(arg) ? (marked.get(arg) ?? []) : []))
}

/**
 * Prepares a returned value. Marked values keep their transferables; binary results move without
 * a copy unless they share their buffer with other data, which is copied instead.
 */
export function prepareResult(value: unknown): { value: unknown; transfer: Transferable[] } {
  const transfers = isObject(value) ? marked.get(value) : undefined
  if (transfers) return { value, transfer: transfers }
  if (value instanceof ArrayBuffer) return { value, transfer: [value] }
  if (!ArrayBuffer.isView(value) || !(value.buffer instanceof ArrayBuffer)) {
    return { value, transfer: [] }
  }
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return { value, transfer: [value.buffer] }
  }
  if (value instanceof DataView) return { value, transfer: [] }
  const copy = (value as Uint8Array).slice()
  return { value: copy, transfer: [copy.buffer] }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}
