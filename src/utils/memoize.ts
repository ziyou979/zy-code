import { LRUCache } from 'lru-cache'
import { logError } from '../services/infra/log.js'
import { jsonStringify } from '../services/infra/slowOperations.js'

type CacheEntry<T> = {
  value: T
  timestamp: number
  refreshing: boolean
}

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
  }
}

type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}

/**
 * 创建在并行刷新期间返回缓存值的 memoized 函数。
 * 实现 write-through cache 模式：
 * - 缓存新鲜时立即返回
 * - 缓存过期时返回旧值，同时在后台刷新
 * - 没有缓存时阻塞并计算值
 *
 * @param f The function to memoize
 * @param cacheLifetimeMs The lifetime of cached values in milliseconds
 * @returns A memoized version of the function
 */
export function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000, // 默认 5 分钟
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()

  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存
    if (!cached) {
      const value = f(...args)
      cache.set(key, {
        value,
        timestamp: now,
        refreshing: false,
      })
      return value
    }

    // 缓存项已过期且尚未刷新时
    if (cached && now - cached.timestamp > cacheLifetimeMs && !cached.refreshing) {
      // 标记为刷新中，避免多次并行刷新
      cached.refreshing = true

      // Schedule async refresh (non-blocking). Both .then and .catch are
      // identity-guarded: a concurrent cache.clear() + cold-miss stores a
      // newer entry while this microtask is queued. .then overwriting with
      // the stale refresh's result is worse than .catch deleting (persists
      // wrong data for full TTL vs. self-correcting on next call).
      Promise.resolve()
        .then(() => {
          const newValue = f(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch((e) => {
          logError(e)
          if (cache.get(key) === cached) {
            cache.delete(key)
          }
        })

      // 立即返回旧值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 添加缓存清理方法
  memoized.cache = {
    clear: () => cache.clear(),
  }

  return memoized
}

/**
 * 创建在并行刷新期间返回缓存值的异步 memoized 函数。
 * 为异步函数实现 write-through cache 模式：
 * - 缓存新鲜时立即返回
 * - 缓存过期时返回旧值，同时在后台刷新
 * - 没有缓存时阻塞并计算值
 *
 * @param f The async function to memoize
 * @param cacheLifetimeMs The lifetime of cached values in milliseconds
 * @returns A memoized version of the async function
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000, // 默认 5 分钟
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  // In-flight cold-miss dedup. The old memoizeWithTTL (sync) accidentally
  // provided this: it stored the Promise synchronously before the first
  // await, so concurrent callers shared one f() invocation. This async
  // variant awaits before cache.set, so concurrent cold-miss callers would
  // each invoke f() independently without this map. For
  // refreshAndGetAwsCredentials that means N concurrent `aws sso login`
  // spawns. Same pattern as pending401Handlers in auth.ts:1171.
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存；如果抛错，不缓存任何内容
    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) {
        return pending
      }
      const promise = f(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        // Identity-guard: cache.clear() during the await should discard this
        // result (clear intent is to invalidate). If we're still in-flight,
        // store it. clear() wipes inFlight too, so this check catches that.
        if (inFlight.get(key) === promise) {
          cache.set(key, {
            value: result,
            timestamp: now,
            refreshing: false,
          })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
    }

    // 缓存项已过期且尚未刷新时
    if (cached && now - cached.timestamp > cacheLifetimeMs && !cached.refreshing) {
      // 标记为刷新中，避免多次并行刷新
      cached.refreshing = true

      // Schedule async refresh (non-blocking). Both .then and .catch are
      // identity-guarded against a concurrent cache.clear() + cold-miss
      // storing a newer entry while this refresh is in flight. .then
      // overwriting with the stale refresh's result is worse than .catch
      // deleting - wrong data persists for full TTL (e.g. credentials from
      // the old awsAuthRefresh command after a settings change).
      const staleEntry = cached
      f(...args)
        .then((newValue) => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch((e) => {
          logError(e)
          if (cache.get(key) === staleEntry) {
            cache.delete(key)
          }
        })

      // 立即返回旧值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // Add cache clear method. Also clear inFlight: clear() during a cold-miss
  // await should not let the stale in-flight promise be returned to the next
  // caller (defeats the purpose of clear). The try/finally above
  // identity-guards inFlight.delete so the stale promise doesn't delete a
  // fresh one if clear+cold-miss happens before the finally fires.
  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }

  return memoized as ((...args: Args) => Promise<Result>) & {
    cache: { clear: () => void }
  }
}

/**
 * 创建使用 LRU（最近最少使用）淘汰策略的 memoized 函数。
 * 缓存达到最大容量时淘汰最近最少使用的条目，避免内存无限增长。
 *
 * Note: Cache size for memoized message processing functions
 * Chosen to prevent unbounded memory growth (was 300MB+ with lodash memoize)
 * while maintaining good cache hit rates for typical conversations.
 *
 * @param f The function to memoize
 * @returns A memoized version of the function with cache management methods
 */
export function memoizeWithLRU<Args extends unknown[], Result extends NonNullable<unknown>>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({
    max: maxCacheSize,
  })

  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const result = f(...args)
    cache.set(key, result)
    return result
  }

  // 添加缓存管理方法
  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    // peek() 不更新最近使用顺序：此处只观察，不提升优先级
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  }

  return memoized
}
