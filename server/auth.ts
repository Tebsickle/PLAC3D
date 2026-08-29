import {
  createHash,
  pbkdf2 as deriveKey,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2 = promisify(deriveKey)
export const PASSWORD_HASH_ALGORITHM = 'pbkdf2-sha256'
export const PASSWORD_HASH_ITERATIONS = 600_000
const PASSWORD_KEY_LENGTH = 32

export type PasswordDigest = {
  algorithm: typeof PASSWORD_HASH_ALGORITHM
  hash: string
  iterations: number
  salt: string
}

export const validatePassword = (password: string) => {
  if (password.length < 12)
    return 'Password must contain at least 12 characters.'
  if (password.length > 128)
    return 'Password must contain no more than 128 characters.'
  return null
}

export const hashPassword = async (password: string): Promise<PasswordDigest> => {
  const passwordError = validatePassword(password)
  if (passwordError) throw new Error(passwordError)
  const salt = randomBytes(16)
  const hash = await pbkdf2(
    password,
    salt,
    PASSWORD_HASH_ITERATIONS,
    PASSWORD_KEY_LENGTH,
    'sha256',
  )
  return {
    algorithm: PASSWORD_HASH_ALGORITHM,
    hash: hash.toString('base64url'),
    iterations: PASSWORD_HASH_ITERATIONS,
    salt: salt.toString('base64url'),
  }
}

export const verifyPassword = async (
  password: string,
  digest: PasswordDigest,
) => {
  if (
    digest.algorithm !== PASSWORD_HASH_ALGORITHM ||
    !Number.isInteger(digest.iterations) ||
    digest.iterations < 1
  )
    return false
  const expected = Buffer.from(digest.hash, 'base64url')
  if (expected.length !== PASSWORD_KEY_LENGTH) return false
  const actual = await pbkdf2(
    password,
    Buffer.from(digest.salt, 'base64url'),
    digest.iterations,
    expected.length,
    'sha256',
  )
  return timingSafeEqual(actual, expected)
}

export const createOpaqueToken = () => randomBytes(32).toString('base64url')
export const hashOpaqueToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url')
