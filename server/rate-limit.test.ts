import assert from 'node:assert/strict'
import test from 'node:test'
import { createRateLimiter } from './rate-limit.js'

test('rate limiter allows the configured number of requests', () => {
  const limiter = createRateLimiter(2, 60_000)
  assert.equal(limiter.take('client', 1_000).allowed, true)
  assert.equal(limiter.take('client', 1_001).allowed, true)
  const blocked = limiter.take('client', 1_002)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.remaining, 0)
  assert.equal(blocked.retryAfterSeconds, 60)
})

test('rate limits are isolated by client and reset after their window', () => {
  const limiter = createRateLimiter(1, 1_000)
  assert.equal(limiter.take('first', 5_000).allowed, true)
  assert.equal(limiter.take('first', 5_500).allowed, false)
  assert.equal(limiter.take('second', 5_500).allowed, true)
  assert.equal(limiter.take('first', 6_000).allowed, true)
})
