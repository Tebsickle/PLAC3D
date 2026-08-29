export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

type RateLimitEntry = {
  count: number
  resetAt: number
}

export const createRateLimiter = (limit: number, windowMs: number) => {
  const entries = new Map<string, RateLimitEntry>()

  const cleanup = (now: number) => {
    for (const [key, entry] of entries)
      if (entry.resetAt <= now) entries.delete(key)
  }

  return {
    take(key: string, now = Date.now()): RateLimitResult {
      let entry = entries.get(key)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs }
        entries.set(key, entry)
      }
      entry.count += 1

      if (entries.size > 10_000) cleanup(now)

      return {
        allowed: entry.count <= limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((entry.resetAt - now) / 1000),
        ),
      }
    },
    cleanup,
  }
}
