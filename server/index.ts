import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import Database from 'better-sqlite3'
import { WebSocket, WebSocketServer } from 'ws'
import {
  COOLDOWN_MS,
  PALETTE,
  WORLD_SIZE,
  chunkKey,
  isInBounds,
  isPaletteId,
  progressionForVoxelCount,
  type ClientMessage,
  type PaletteId,
  type ServerMessage,
  type Voxel,
} from '../shared/protocol.js'
import {
  PASSWORD_HASH_ALGORITHM,
  PASSWORD_HASH_ITERATIONS,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  validatePassword,
  verifyPassword,
  type PasswordDigest,
} from './auth.js'
import { sendEmail } from './email.js'
import { createRateLimiter } from './rate-limit.js'

const port = Number(process.env.PORT ?? 8787)
const isProduction = process.env.NODE_ENV === 'production'
const secret = process.env.SESSION_SECRET ?? 'local-development-secret'
const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173'
let parsedAppOrigin: URL
try {
  parsedAppOrigin = new URL(appOrigin)
} catch {
  throw new Error('APP_ORIGIN must be a valid absolute URL.')
}
if (isProduction && parsedAppOrigin.protocol !== 'https:')
  throw new Error('APP_ORIGIN must use HTTPS in production.')
if (isProduction && secret.length < 32)
  throw new Error('SESSION_SECRET must contain at least 32 characters in production.')
const sessionDurationMs = 60 * 60 * 1000
const verificationDurationMs = 30 * 60 * 1000
const passwordResetDurationMs = 30 * 60 * 1000
const loginRateLimiter = createRateLimiter(20, 15 * 60 * 1000)
const registrationRateLimiter = createRateLimiter(10, 60 * 60 * 1000)
const forgotPasswordRateLimiter = createRateLimiter(10, 60 * 60 * 1000)
const resetPasswordRateLimiter = createRateLimiter(20, 60 * 60 * 1000)
const websocketRateLimiter = createRateLimiter(60, 60 * 1000)
const database = new Database(process.env.DATABASE_PATH ?? './plac3d.db')
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')
database.exec(`CREATE TABLE IF NOT EXISTS voxels (x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, color TEXT NOT NULL, PRIMARY KEY (x, y, z));`)
database.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, cooldown_until INTEGER NOT NULL DEFAULT 0);`)
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_algorithm TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    password_salt TEXT NOT NULL,
    email_verified_at INTEGER NOT NULL,
    voxel_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_registrations (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_algorithm TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    password_salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS auth_sessions_expires_at ON auth_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS pending_registrations_expires_at ON pending_registrations(expires_at);
  CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
`)
if ((database.prepare('SELECT COUNT(*) AS count FROM voxels').get() as { count: number }).count === 0) {
  const seed = database.transaction(() => {
    const insert = database.prepare('INSERT INTO voxels (x, y, z, color) VALUES (?, ?, ?, ?)')
    for (let x = 490; x < 510; x += 1) for (let z = 490; z < 510; z += 1) {
      const distance = Math.hypot(x - 500, z - 500)
      const height = Math.max(0, Math.floor(8 - distance * 0.7))
      for (let y = 0; y <= height; y += 1) insert.run(x, y, z, 'white')
    }
  })
  seed()
}
const paletteIds = PALETTE.map(({ id }) => id)
const palettePlaceholders = paletteIds.map(() => '?').join(', ')
database.prepare(`UPDATE voxels SET color = ? WHERE color NOT IN (${palettePlaceholders})`).run('white', ...paletteIds)

const subscriptions = new Map<WebSocket, Set<string>>()
const authCookieName = 'plac3d_session'
type AuthenticatedUser = {
  id: number
  username: string
  voxelCount: number
  cooldownUntil: number
}
type UserWithPassword = AuthenticatedUser & {
  email: string
  passwordAlgorithm: PasswordDigest['algorithm']
  passwordHash: string
  passwordIterations: number
  passwordSalt: string
}
type PendingRegistration = {
  email: string
  username: string
  passwordAlgorithm: PasswordDigest['algorithm']
  passwordHash: string
  passwordIterations: number
  passwordSalt: string
  expiresAt: number
}
const dummyPasswordDigest: PasswordDigest = {
  algorithm: PASSWORD_HASH_ALGORITHM,
  hash: Buffer.alloc(32).toString('base64url'),
  iterations: PASSWORD_HASH_ITERATIONS,
  salt: Buffer.alloc(16).toString('base64url'),
}
const cookieValue = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    if (key !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}
const getAuthenticatedUser = database.prepare(`
  SELECT
    users.id,
    users.username,
    users.voxel_count AS voxelCount,
    users.cooldown_until AS cooldownUntil
  FROM auth_sessions
  JOIN users ON users.id = auth_sessions.user_id
  WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
`)
const authenticatedUserFor = (sessionToken: string | null) => {
  if (!sessionToken) return null
  return (
    (getAuthenticatedUser.get(
      hashOpaqueToken(sessionToken),
      Date.now(),
    ) as AuthenticatedUser | undefined) ?? null
  )
}
const userPayload = (user: AuthenticatedUser) => ({
  username: user.username,
  voxelCount: user.voxelCount,
  ...progressionForVoxelCount(user.voxelCount),
})
const sessionCookie = (token: string, maxAgeSeconds = 60 * 60) => {
  const secure = parsedAppOrigin.protocol === 'https:' ? '; Secure' : ''
  return `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}
const clearSessionCookie = () =>
  `${authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${parsedAppOrigin.protocol === 'https:' ? '; Secure' : ''}`
const securityHeaders: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}
const applySecurityHeaders = (response: ServerResponse) => {
  for (const [name, value] of Object.entries(securityHeaders))
    response.setHeader(name, value)
}
const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  applySecurityHeaders(response)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}
const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 32 * 1024) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    throw new Error('INVALID_JSON')
  }
}
const isSameOriginRequest = (request: IncomingMessage) => {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}
const clientKeyFor = (request: IncomingMessage) => {
  const cloudflareAddress = isProduction
    ? request.headers['cf-connecting-ip']
    : undefined
  const normalizedCloudflareAddress = Array.isArray(cloudflareAddress)
    ? cloudflareAddress[0]
    : cloudflareAddress
  return (
    normalizedCloudflareAddress?.trim() ||
    request.socket.remoteAddress ||
    'unknown-client'
  )
}
const linkOriginForRequest = (request: IncomingMessage) =>
  !isProduction && request.headers.origin
    ? request.headers.origin.replace(/\/$/, '')
    : appOrigin
const normalizedEmail = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''
const normalizedUsername = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''
const emailError = (email: string) => {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return 'Enter a valid email address.'
  return null
}
const usernameError = (username: string) => {
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username))
    return 'Username must be 3–24 characters using letters, numbers, or underscores.'
  return null
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character]!,
  )
const tokenFor = (id: string) => `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`
const validToken = (token: string) => {
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [id, signature] = parts
  if (!id || !signature) return false
  const expected = tokenFor(id).split('.')[1]
  const actualBuffer = Buffer.from(signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}
const send = (socket: WebSocket, message: ServerMessage) => {
  if (socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch (error) {
    console.error('Failed to send WebSocket message.', error)
    return false
  }
}
const upsertVoxel = database.prepare('INSERT INTO voxels (x, y, z, color) VALUES (?, ?, ?, ?) ON CONFLICT(x, y, z) DO UPDATE SET color = excluded.color')
const deleteVoxel = database.prepare('DELETE FROM voxels WHERE x = ? AND y = ? AND z = ?')
const recordUserPlacement = database.prepare(`
  UPDATE users
  SET cooldown_until = ?, voxel_count = voxel_count + ?
  WHERE id = ?
`)
const findRegisteredUser = database.prepare(`
  SELECT email, username FROM users WHERE email = ? OR username = ? LIMIT 1
`)
const deleteExpiredPendingRegistrations = database.prepare(
  'DELETE FROM pending_registrations WHERE expires_at <= ?',
)
const deletePendingRegistrationConflicts = database.prepare(`
  DELETE FROM pending_registrations WHERE email = ? OR username = ?
`)
const insertPendingRegistration = database.prepare(`
  INSERT INTO pending_registrations (
    token_hash,
    email,
    username,
    password_algorithm,
    password_hash,
    password_iterations,
    password_salt,
    expires_at,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const findPendingRegistration = database.prepare(`
  SELECT
    email,
    username,
    password_algorithm AS passwordAlgorithm,
    password_hash AS passwordHash,
    password_iterations AS passwordIterations,
    password_salt AS passwordSalt,
    expires_at AS expiresAt
  FROM pending_registrations
  WHERE token_hash = ?
`)
const deletePendingRegistration = database.prepare(
  'DELETE FROM pending_registrations WHERE token_hash = ?',
)
const insertVerifiedUser = database.prepare(`
  INSERT INTO users (
    email,
    username,
    password_algorithm,
    password_hash,
    password_iterations,
    password_salt,
    email_verified_at,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const findUserByIdentity = database.prepare(`
  SELECT
    id,
    email,
    username,
    password_algorithm AS passwordAlgorithm,
    password_hash AS passwordHash,
    password_iterations AS passwordIterations,
    password_salt AS passwordSalt,
    voxel_count AS voxelCount,
    cooldown_until AS cooldownUntil
  FROM users
  WHERE email = ? OR username = ?
  LIMIT 1
`)
const deleteExpiredAuthSessions = database.prepare(
  'DELETE FROM auth_sessions WHERE expires_at <= ?',
)
const insertAuthSession = database.prepare(`
  INSERT INTO auth_sessions (
    token_hash, user_id, expires_at, created_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?)
`)
const refreshAuthSession = database.prepare(`
  UPDATE auth_sessions SET expires_at = ?, last_seen_at = ?
  WHERE token_hash = ? AND expires_at > ?
`)
const deleteAuthSession = database.prepare(
  'DELETE FROM auth_sessions WHERE token_hash = ?',
)
const findUserForPasswordReset = database.prepare(`
  SELECT id, email, username FROM users WHERE email = ? LIMIT 1
`)
const deleteExpiredPasswordResetTokens = database.prepare(
  'DELETE FROM password_reset_tokens WHERE expires_at <= ?',
)
const deletePasswordResetTokensForUser = database.prepare(
  'DELETE FROM password_reset_tokens WHERE user_id = ?',
)
const insertPasswordResetToken = database.prepare(`
  INSERT INTO password_reset_tokens (
    token_hash, user_id, expires_at, created_at
  ) VALUES (?, ?, ?, ?)
`)
const findPasswordResetToken = database.prepare(`
  SELECT user_id AS userId, expires_at AS expiresAt
  FROM password_reset_tokens
  WHERE token_hash = ?
`)
const updateUserPassword = database.prepare(`
  UPDATE users
  SET
    password_algorithm = ?,
    password_hash = ?,
    password_iterations = ?,
    password_salt = ?
  WHERE id = ?
`)
const deleteAuthSessionsForUser = database.prepare(
  'DELETE FROM auth_sessions WHERE user_id = ?',
)
const cleanupExpiredAccountData = database.transaction((now: number) => {
  deleteExpiredPendingRegistrations.run(now)
  deleteExpiredAuthSessions.run(now)
  deleteExpiredPasswordResetTokens.run(now)
})
cleanupExpiredAccountData(Date.now())
const accountCleanupTimer = setInterval(
  () => cleanupExpiredAccountData(Date.now()),
  15 * 60 * 1000,
)
accountCleanupTimer.unref()
const parse = (raw: string): ClientMessage | null => {
  try { return JSON.parse(raw) as ClientMessage } catch { return null }
}
const voxelsInChunks = (keys: string[]) => {
  if (!keys.length) return {}
  const requested = new Set(keys)
  const result: Record<string, Voxel[]> = Object.fromEntries(
    keys.map((key) => [key, []]),
  )
  const rows = database.prepare('SELECT x, y, z, color FROM voxels').all() as Voxel[]
  for (const voxel of rows) {
    const key = chunkKey(voxel.x, voxel.y, voxel.z)
    if (requested.has(key)) result[key].push(voxel)
  }
  return result
}
const broadcast = (voxels: Voxel[], erased: Array<{ x: number; y: number; z: number }>) => {
  const affected = new Set([...voxels, ...erased].map(({ x, y, z }) => chunkKey(x, y, z)))
  for (const [socket, subscribed] of subscriptions) {
    if ([...affected].some((key) => subscribed.has(key))) send(socket, { type: 'updates', voxels, erased })
  }
}

const authPostLimiters = new Map([
  ['/api/auth/register', registrationRateLimiter],
  ['/api/auth/forgot-password', forgotPasswordRateLimiter],
  ['/api/auth/reset-password', resetPasswordRateLimiter],
  ['/api/auth/login', loginRateLimiter],
])

const handleAuthRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  )
  if (!url.pathname.startsWith('/api/auth/')) return false

  if (request.method === 'POST' && !isSameOriginRequest(request)) {
    sendJson(response, 403, { error: 'Request origin was not accepted.' })
    return true
  }

  const rateLimiter = authPostLimiters.get(url.pathname)
  if (request.method === 'POST' && rateLimiter) {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'Request body must use JSON.' })
      return true
    }
    const rateLimit = rateLimiter.take(clientKeyFor(request))
    if (!rateLimit.allowed) {
      sendJson(
        response,
        429,
        { error: 'Too many attempts. Wait a while and try again.' },
        { 'retry-after': String(rateLimit.retryAfterSeconds) },
      )
      return true
    }
  }

  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readJson(request)
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, {
        error: 'Registration data must be valid JSON.',
      })
      return true
    }
    const email = normalizedEmail(body.email)
    const username = normalizedUsername(body.username)
    const password = typeof body.password === 'string' ? body.password : ''
    const validationError =
      emailError(email) ?? usernameError(username) ?? validatePassword(password)
    if (validationError) {
      sendJson(response, 400, { error: validationError })
      return true
    }

    const registered = findRegisteredUser.get(email, username) as
      | { email: string; username: string }
      | undefined
    if (registered) {
      sendJson(response, 409, {
        error:
          registered.email.toLowerCase() === email
            ? 'An account already uses that email address.'
            : 'That username is already taken.',
      })
      return true
    }

    const digest = await hashPassword(password)
    const verificationToken = createOpaqueToken()
    const tokenHash = hashOpaqueToken(verificationToken)
    const now = Date.now()
    const expiresAt = now + verificationDurationMs
    const savePendingRegistration = database.transaction(() => {
      deleteExpiredPendingRegistrations.run(now)
      deletePendingRegistrationConflicts.run(email, username)
      insertPendingRegistration.run(
        tokenHash,
        email,
        username,
        digest.algorithm,
        digest.hash,
        digest.iterations,
        digest.salt,
        expiresAt,
        now,
      )
    })
    try {
      savePendingRegistration()
    } catch (error) {
      console.error('Failed to save pending registration.', error)
      sendJson(response, 409, {
        error: 'That email or username is already awaiting confirmation.',
      })
      return true
    }

    const verificationUrl = `${linkOriginForRequest(request)}/api/auth/verify?token=${encodeURIComponent(verificationToken)}`
    let delivered = false
    try {
      const emailResult = await sendEmail({
        to: email,
        subject: 'Confirm your PLAC3D account',
        idempotencySource: `registration:${tokenHash}`,
        text: `Hi ${username},\n\nConfirm your PLAC3D account within 30 minutes:\n${verificationUrl}\n\nIf you did not request this account, you can ignore this email.`,
        html: `<p>Hi ${escapeHtml(username)},</p><p>Confirm your PLAC3D account within 30 minutes:</p><p><a href="${escapeHtml(verificationUrl)}">Confirm PLAC3D account</a></p><p>If you did not request this account, you can ignore this email.</p>`,
      })
      delivered = emailResult.delivered
    } catch (error) {
      console.error('Failed to send registration email.', error)
      sendJson(response, 502, {
        error: 'Registration was saved, but the confirmation email could not be sent. Please submit the form again.',
      })
      return true
    }

    if (!delivered)
      console.log(`Development verification link for ${email}: ${verificationUrl}`)
    sendJson(response, 202, {
      ok: true,
      message:
        'Check your email and confirm your account within 30 minutes.',
      ...(!delivered && !isProduction
        ? { developmentVerificationUrl: verificationUrl }
        : {}),
    })
    return true
  }

  if (url.pathname === '/api/auth/verify' && request.method === 'GET') {
    const token = url.searchParams.get('token') ?? ''
    const tokenHash = hashOpaqueToken(token)
    const pending = findPendingRegistration.get(tokenHash) as
      | PendingRegistration
      | undefined
    if (!pending) {
      response.writeHead(302, { location: '/?auth=invalid' })
      response.end()
      return true
    }
    if (pending.expiresAt <= Date.now()) {
      deletePendingRegistration.run(tokenHash)
      response.writeHead(302, { location: '/?auth=expired' })
      response.end()
      return true
    }

    const now = Date.now()
    const confirmRegistration = database.transaction(() => {
      insertVerifiedUser.run(
        pending.email,
        pending.username,
        pending.passwordAlgorithm,
        pending.passwordHash,
        pending.passwordIterations,
        pending.passwordSalt,
        now,
        now,
      )
      deletePendingRegistration.run(tokenHash)
    })
    try {
      confirmRegistration()
      response.writeHead(302, { location: '/?auth=verified' })
    } catch (error) {
      console.error('Failed to confirm registration.', error)
      deletePendingRegistration.run(tokenHash)
      response.writeHead(302, { location: '/?auth=conflict' })
    }
    response.end()
    return true
  }

  if (
    url.pathname === '/api/auth/forgot-password' &&
    request.method === 'POST'
  ) {
    let body: Record<string, unknown>
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'Password recovery data must be valid JSON.' })
      return true
    }
    const email = normalizedEmail(body.email)
    const genericResponse = {
      ok: true,
      message:
        'If an account uses that email, a password-reset link has been sent. It expires after 30 minutes.',
    }
    if (emailError(email)) {
      sendJson(response, 202, genericResponse)
      return true
    }
    const user = findUserForPasswordReset.get(email) as
      | { id: number; email: string; username: string }
      | undefined
    if (!user) {
      sendJson(response, 202, genericResponse)
      return true
    }

    const resetToken = createOpaqueToken()
    const tokenHash = hashOpaqueToken(resetToken)
    const now = Date.now()
    const expiresAt = now + passwordResetDurationMs
    const savePasswordReset = database.transaction(() => {
      deleteExpiredPasswordResetTokens.run(now)
      deletePasswordResetTokensForUser.run(user.id)
      insertPasswordResetToken.run(tokenHash, user.id, expiresAt, now)
    })
    savePasswordReset()
    const resetUrl = `${linkOriginForRequest(request)}/?resetToken=${encodeURIComponent(resetToken)}`
    let delivered = false
    try {
      const emailResult = await sendEmail({
        to: user.email,
        subject: 'Reset your PLAC3D password',
        idempotencySource: `password-reset:${tokenHash}`,
        text: `Hi ${user.username},\n\nUse this private link to change your PLAC3D password within 30 minutes:\n${resetUrl}\n\nIf you did not request a reset, you can ignore this email.`,
        html: `<p>Hi ${escapeHtml(user.username)},</p><p>Use this private link to change your PLAC3D password within 30 minutes:</p><p><a href="${escapeHtml(resetUrl)}">Change PLAC3D password</a></p><p>If you did not request a reset, you can ignore this email.</p>`,
      })
      delivered = emailResult.delivered
    } catch (error) {
      console.error('Failed to send password-reset email.', error)
    }
    if (!delivered && !isProduction)
      console.log(`Development password-reset link for ${email}: ${resetUrl}`)
    sendJson(response, 202, {
      ...genericResponse,
      ...(!delivered && !isProduction
        ? { developmentResetUrl: resetUrl }
        : {}),
    })
    return true
  }

  if (
    url.pathname === '/api/auth/reset-password' &&
    request.method === 'POST'
  ) {
    let body: Record<string, unknown>
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'Password reset data must be valid JSON.' })
      return true
    }
    const token = typeof body.token === 'string' ? body.token : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const passwordError = validatePassword(password)
    if (!token || passwordError) {
      sendJson(response, 400, {
        error: passwordError ?? 'Password-reset token is required.',
      })
      return true
    }
    const tokenHash = hashOpaqueToken(token)
    const reset = findPasswordResetToken.get(tokenHash) as
      | { userId: number; expiresAt: number }
      | undefined
    if (!reset || reset.expiresAt <= Date.now()) {
      if (reset) deletePasswordResetTokensForUser.run(reset.userId)
      sendJson(response, 400, {
        error: 'That password-reset link is invalid or expired.',
      })
      return true
    }

    const digest = await hashPassword(password)
    const replacePassword = database.transaction(() => {
      updateUserPassword.run(
        digest.algorithm,
        digest.hash,
        digest.iterations,
        digest.salt,
        reset.userId,
      )
      deletePasswordResetTokensForUser.run(reset.userId)
      deleteAuthSessionsForUser.run(reset.userId)
    })
    replacePassword()
    sendJson(
      response,
      200,
      {
        ok: true,
        message: 'Password changed. Log in with your new password.',
      },
      { 'set-cookie': clearSessionCookie() },
    )
    return true
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'Login data must be valid JSON.' })
      return true
    }
    const identity =
      typeof body.identity === 'string' ? body.identity.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!identity || !password) {
      sendJson(response, 400, { error: 'Enter your email or username and password.' })
      return true
    }
    const user = findUserByIdentity.get(identity, identity) as
      | UserWithPassword
      | undefined
    const passwordMatches = await verifyPassword(
      password,
      user
        ? {
            algorithm: user.passwordAlgorithm,
            hash: user.passwordHash,
            iterations: user.passwordIterations,
            salt: user.passwordSalt,
          }
        : dummyPasswordDigest,
    )
    if (!user || !passwordMatches) {
      sendJson(response, 401, { error: 'Email, username, or password is incorrect.' })
      return true
    }

    const now = Date.now()
    const sessionToken = createOpaqueToken()
    const createAuthenticatedSession = database.transaction(() => {
      deleteExpiredAuthSessions.run(now)
      insertAuthSession.run(
        hashOpaqueToken(sessionToken),
        user.id,
        now + sessionDurationMs,
        now,
        now,
      )
    })
    createAuthenticatedSession()
    sendJson(
      response,
      200,
      {
        ok: true,
        user: userPayload(user),
        cooldownUntil: user.cooldownUntil,
      },
      { 'set-cookie': sessionCookie(sessionToken) },
    )
    return true
  }

  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    const token = cookieValue(request.headers.cookie, authCookieName)
    const user = authenticatedUserFor(token)
    if (!token || !user) {
      sendJson(
        response,
        200,
        { user: null, cooldownUntil: 0 },
        token ? { 'set-cookie': clearSessionCookie() } : {},
      )
      return true
    }
    const now = Date.now()
    refreshAuthSession.run(
      now + sessionDurationMs,
      now,
      hashOpaqueToken(token),
      now,
    )
    sendJson(
      response,
      200,
      { user: userPayload(user), cooldownUntil: user.cooldownUntil },
      { 'set-cookie': sessionCookie(token) },
    )
    return true
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = cookieValue(request.headers.cookie, authCookieName)
    if (token) deleteAuthSession.run(hashOpaqueToken(token))
    sendJson(
      response,
      200,
      { ok: true },
      { 'set-cookie': clearSessionCookie() },
    )
    return true
  }

  sendJson(response, 404, { error: 'Authentication route not found.' })
  return true
}

const contentTypes: Record<string, string> = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const distRoot = normalize(join(process.cwd(), 'dist'))
const httpServer = createServer(async (request, response) => {
  applySecurityHeaders(response)
  if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok' })); return }
  try {
    if (await handleAuthRequest(request, response)) return
  } catch (error) {
    console.error('Authentication request failed.', error)
    if (!response.headersSent)
      sendJson(response, 500, { error: 'Authentication request failed.' })
    else response.destroy()
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  let requestedPath: string
  try {
    requestedPath = decodeURIComponent((request.url ?? '/').split('?')[0])
  } catch {
    response.writeHead(400)
    response.end('Invalid path')
    return
  }
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1)
  const filePath = normalize(join(distRoot, relativePath))
  if (!filePath.startsWith(`${distRoot}${sep}`)) { response.writeHead(400); response.end('Invalid path'); return }
  try {
    const content = await readFile(filePath)
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' })
    response.end(request.method === 'HEAD' ? undefined : content)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
const wss = new WebSocketServer({ server: httpServer, maxPayload: 256 * 1024 })
const responsiveSockets = new WeakSet<WebSocket>()
wss.on('connection', (socket, request) => {
  const requestPath = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  ).pathname
  if (requestPath !== '/ws' || !isSameOriginRequest(request)) {
    socket.close(1008, 'WebSocket origin was not accepted.')
    return
  }
  const connectionLimit = websocketRateLimiter.take(clientKeyFor(request))
  if (!connectionLimit.allowed) {
    socket.close(1013, 'Too many connection attempts.')
    return
  }
  let token = ''
  const sessionToken = cookieValue(request.headers.cookie, authCookieName)
  responsiveSockets.add(socket)
  subscriptions.set(socket, new Set())
  socket.on('pong', () => responsiveSockets.add(socket))
  socket.on('message', (data) => {
    const message = parse(data.toString())
    if (!message) return send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Message must be valid JSON.' })
    if (message.type === 'hello') {
      token = message.token && validToken(message.token) ? message.token : tokenFor(randomBytes(18).toString('hex'))
      const authenticatedUser = authenticatedUserFor(sessionToken)
      return send(socket, {
        type: 'hello',
        token,
        cooldownUntil: authenticatedUser?.cooldownUntil ?? 0,
        user: authenticatedUser
          ? userPayload(authenticatedUser)
          : null,
      })
    }
    if (!token) return send(socket, { type: 'error', code: 'NOT_INITIALIZED', message: 'Send hello first.' })
    if (message.type === 'subscribe') {
      const keys = message.chunks.filter((key) => /^\d{1,3},\d{1,3},\d{1,3}$/.test(key)).slice(0, 256)
      subscriptions.set(socket, new Set(keys)); return send(socket, { type: 'chunks', chunks: voxelsInChunks(keys) })
    }
    if (message.type === 'place') {
      const authenticatedUser = authenticatedUserFor(sessionToken)
      if (!authenticatedUser)
        return send(socket, {
          type: 'error',
          requestId: message.requestId,
          code: 'AUTH_REQUIRED',
          message: 'Log in before submitting voxels.',
        })
      const cooldownUntil = authenticatedUser.cooldownUntil
      if (Date.now() < cooldownUntil) return send(socket, { type: 'error', requestId: message.requestId, code: 'COOLDOWN', message: 'Your next placement is not ready yet.', cooldownUntil })
      const { batchLimit } = progressionForVoxelCount(
        authenticatedUser.voxelCount,
      )
      if (!Array.isArray(message.placements) || message.placements.length === 0 || message.placements.length > batchLimit) return send(socket, { type: 'error', requestId: message.requestId, code: 'BATCH_LIMIT', message: `Your level allows batches of 1 to ${batchLimit} voxels.` })
      const unique = new Set<string>(); const accepted: Voxel[] = []; const erased: Array<{ x: number; y: number; z: number }> = []
      for (const placement of message.placements) {
        if (!isInBounds(placement.x) || !isInBounds(placement.y) || !isInBounds(placement.z)) return send(socket, { type: 'error', requestId: message.requestId, code: 'OUT_OF_BOUNDS', message: `Coordinates must be within 0 and ${WORLD_SIZE - 1}.` })
        if (placement.color !== 'erase' && !isPaletteId(placement.color)) return send(socket, { type: 'error', requestId: message.requestId, code: 'INVALID_COLOR', message: 'Choose a color from the approved palette.' })
        const key = `${placement.x},${placement.y},${placement.z}`
        if (unique.has(key)) return send(socket, { type: 'error', requestId: message.requestId, code: 'DUPLICATE', message: 'A batch cannot contain duplicate coordinates.' })
        unique.add(key)
        if (placement.color === 'erase') erased.push(placement)
        else accepted.push({ ...placement, color: placement.color as PaletteId })
      }
      const nextCooldown = Date.now() + COOLDOWN_MS
      const transaction = database.transaction(() => {
        for (const voxel of accepted) upsertVoxel.run(voxel.x, voxel.y, voxel.z, voxel.color)
        for (const voxel of erased) deleteVoxel.run(voxel.x, voxel.y, voxel.z)
        recordUserPlacement.run(
          nextCooldown,
          message.placements.length,
          authenticatedUser.id,
        )
        if (sessionToken) {
          const now = Date.now()
          refreshAuthSession.run(
            now + sessionDurationMs,
            now,
            hashOpaqueToken(sessionToken),
            now,
          )
        }
      })
      try {
        transaction()
      } catch (error) {
        console.error('Failed to commit voxel placement.', error)
        return send(socket, {
          type: 'error',
          requestId: message.requestId,
          code: 'DATABASE_WRITE_FAILED',
          message: 'The batch could not be saved. Please try again.',
        })
      }
      broadcast(accepted, erased)
      return send(socket, {
        type: 'placed',
        requestId: message.requestId,
        cooldownUntil: nextCooldown,
        count: message.placements.length,
        voxels: accepted,
        erased,
      })
    }
  })
  socket.on('close', () => subscriptions.delete(socket))
  socket.on('error', (error) => {
    console.error('WebSocket connection failed.', error)
    subscriptions.delete(socket)
  })
})
const websocketHeartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue
    if (!responsiveSockets.has(socket)) {
      subscriptions.delete(socket)
      socket.terminate()
      continue
    }
    responsiveSockets.delete(socket)
    socket.ping()
  }
}, 30_000)
websocketHeartbeat.unref()
wss.on('close', () => clearInterval(websocketHeartbeat))
httpServer.listen(port, () => console.log(`PLAC3D server listening on http://localhost:${port}`))
