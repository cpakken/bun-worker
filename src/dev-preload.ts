import { rawImportsPlugin } from './raw-imports'

// Preloaded into dev workers, which run source directly instead of a build.
Bun.plugin(rawImportsPlugin())
