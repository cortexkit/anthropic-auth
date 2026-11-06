import {
  CacheKeepStore as SharedCacheKeepStore,
  type CacheKeepStoreOptions as SharedCacheKeepStoreOptions,
} from '@cortexkit/anthropic-auth-core'
import { version as pluginVersion } from '../../package.json'

export {
  cacheKeepStoreDirectory,
  legacyCacheKeepStoreDirectory,
  type SavedCacheKeepTarget,
} from '@cortexkit/anthropic-auth-core'

export type CacheKeepStoreOptions = Omit<
  SharedCacheKeepStoreOptions,
  'pluginVersion' | 'host'
>

export class CacheKeepStore extends SharedCacheKeepStore {
  constructor(options: CacheKeepStoreOptions, previous?: CacheKeepStore) {
    super({ ...options, pluginVersion }, previous)
  }
}
