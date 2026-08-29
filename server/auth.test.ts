import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PASSWORD_HASH_ALGORITHM,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  validatePassword,
  verifyPassword,
} from './auth.js'

test('passwords are stored as salted PBKDF2-SHA-256 digests', async () => {
  const password = 'correct horse battery staple'
  const first = await hashPassword(password)
  const second = await hashPassword(password)

  assert.equal(first.algorithm, PASSWORD_HASH_ALGORITHM)
  assert.notEqual(first.hash, password)
  assert.notEqual(first.hash, second.hash)
  assert.notEqual(first.salt, second.salt)
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword('incorrect password', first), false)
})

test('password validation enforces safe length bounds', () => {
  assert.match(validatePassword('too-short') ?? '', /at least 12/)
  assert.match(validatePassword('x'.repeat(129)) ?? '', /no more than 128/)
  assert.equal(validatePassword('a secure password'), null)
})

test('opaque account tokens are random and stored only as SHA-256 hashes', () => {
  const first = createOpaqueToken()
  const second = createOpaqueToken()

  assert.notEqual(first, second)
  assert.notEqual(hashOpaqueToken(first), first)
  assert.equal(hashOpaqueToken(first), hashOpaqueToken(first))
})
