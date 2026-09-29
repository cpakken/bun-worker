import { isAbsolute } from 'node:path'

/**
 * Reads a `with { type: 'file' }` import. Bun bundles (such as Nitro output) resolve it relative
 * to the importing module; runtime resolution and compiled executables give absolute paths.
 */
export async function readFileAsset(assetPath: string, moduleUrl: string) {
  const file = Bun.file(isAbsolute(assetPath) ? assetPath : new URL(assetPath, moduleUrl))
  return new Uint8Array(await file.arrayBuffer())
}
